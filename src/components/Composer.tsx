import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { Attachment, Chat } from "../types";
import { useUi } from "../ui";
import { ModelPicker } from "./ModelPicker";

const NO_ATTACHMENTS: Attachment[] = [];
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const MAX_SUGGESTIONS = 8;

interface Suggestion {
  /** What replaces the token being typed. */
  insert: string;
  label: string;
  detail?: string;
}

/** The `@file` or `/command` being typed just before the caret, if any. */
export function tokenAt(text: string, caret: number): { kind: "file" | "command"; query: string; start: number } | null {
  const before = text.slice(0, caret);
  const file = /(^|\s)@([\w./-]*)$/.exec(before);
  if (file) return { kind: "file", query: file[2], start: caret - file[2].length - 1 };
  // A slash command is only one as the very first thing in the message.
  const command = /^\/([\w:-]*)$/.exec(before);
  if (command) return { kind: "command", query: command[1], start: 0 };
  return null;
}

/** Best matches first: name starts with the query, then name contains it, then the path does. */
export function rankFiles(files: string[], query: string): string[] {
  const needle = query.toLowerCase();
  if (!needle) return files.slice(0, MAX_SUGGESTIONS);
  const scored: [number, string][] = [];
  for (const path of files) {
    const lower = path.toLowerCase();
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    const score = name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : lower.includes(needle) ? 2 : -1;
    if (score >= 0) scored.push([score, path]);
  }
  return scored
    .sort((a, b) => a[0] - b[0] || a[1].length - b[1].length)
    .slice(0, MAX_SUGGESTIONS)
    .map(([, path]) => path);
}

function readAsBase64(file: File): Promise<{ data: string; url: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const url = String(reader.result);
      resolve({ data: url.slice(url.indexOf(",") + 1), url });
    };
    reader.readAsDataURL(file);
  });
}

export function Composer(props: {
  chat: Chat;
  busy: boolean;
  placeholder: string;
  /** Whether the agent can still be swapped for the other one. */
  canPickAgent: boolean;
  onStop: () => void;
}) {
  const { chat, busy, placeholder, canPickAgent, onStop } = props;
  const text = useUi((s) => s.drafts[chat.id] ?? "");
  const attachments = useUi((s) => s.attachments[chat.id]) ?? NO_ATTACHMENTS;
  const queue = useUi((s) => s.queues[chat.id]);
  const commands = useUi((s) => s.commands);
  const { setDraft, setAttachments, enqueue, unqueue } = useUi.getState();
  const { sendMessage, setChatAgent, setChatPlan, reportError } = useStore.getState();

  const input = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [picked, setPicked] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [files, setFiles] = useState<string[] | null>(null);

  useEffect(() => input.current?.focus(), [chat.id]);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  }, [text]);

  const token = dismissed ? null : tokenAt(text, caret);
  // The file list is fetched the first time an @ is typed in this chat.
  useEffect(() => {
    if (token?.kind === "file" && files === null) {
      api.listChatFiles(chat.id).then(setFiles, () => setFiles([]));
    }
  }, [token?.kind, files, chat.id]);

  const suggestions: Suggestion[] = useMemo(() => {
    if (!token) return [];
    if (token.kind === "file") {
      return rankFiles(files ?? [], token.query).map((path) => ({
        insert: `@${path} `,
        label: path.slice(path.lastIndexOf("/") + 1),
        detail: path,
      }));
    }
    const needle = token.query.toLowerCase();
    return commands
      .filter((c) => c.name.toLowerCase().includes(needle))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(needle)) - Number(!b.name.toLowerCase().startsWith(needle)))
      .slice(0, MAX_SUGGESTIONS)
      .map((c) => ({ insert: `/${c.name} `, label: `/${c.name}`, detail: c.description }));
  }, [token?.kind, token?.query, files, commands]);
  const choice = Math.min(picked, suggestions.length - 1);

  const change = (value: string, at: number) => {
    setDraft(chat.id, value);
    setCaret(at);
    setPicked(0);
    setDismissed(false);
  };

  const accept = (suggestion: Suggestion) => {
    if (!token) return;
    const next = text.slice(0, token.start) + suggestion.insert + text.slice(caret);
    const at = token.start + suggestion.insert.length;
    change(next, at);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(at, at);
    });
  };

  const attach = (added: Attachment[]) => setAttachments(chat.id, [...attachments, ...added]);

  /** Saves pasted or dropped file contents so the agent can be given a path. */
  const attachFiles = async (list: File[]) => {
    try {
      const added: Attachment[] = [];
      for (const file of list) {
        const { data, url } = await readAsBase64(file);
        const name = file.name || `pasted.${file.type.split("/")[1] ?? "png"}`;
        const path = await api.saveAttachment(name, data);
        added.push({ path, name, preview: file.type.startsWith("image/") ? url : undefined });
      }
      if (added.length > 0) attach(added);
    } catch (e) {
      reportError(e);
    }
  };

  const browse = async () => {
    const chosen = await open({ multiple: true, title: "Attach files" });
    const paths = Array.isArray(chosen) ? chosen : chosen ? [chosen] : [];
    attach(paths.map((path) => ({ path, name: path.slice(path.lastIndexOf("/") + 1) })));
  };

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    const message = { text: trimmed, attachments };
    // While the agent is working, the message waits its turn.
    if (busy) enqueue(chat.id, message);
    else void sendMessage(chat.id, trimmed, attachments.map((a) => a.path));
    setDraft(chat.id, "");
    setAttachments(chat.id, []);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setPicked((choice + step + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        accept(suggestions[choice]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    // With nothing typed, the up arrow brings back the last message sent.
    if (e.key === "ArrowUp" && text === "") {
      const events = useStore.getState().transcripts[chat.id] ?? [];
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type !== "productor_user") continue;
        e.preventDefault();
        change(events[i].text, events[i].text.length);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const canPlan = chat.agent === "claude" && chat.workspaceId !== null;
  const empty = !text.trim() && attachments.length === 0;

  return (
    <div className="composer">
      {queue && queue.length > 0 && (
        <ul className="queue">
          {queue.map((message, i) => (
            <li key={i}>
              <span className="queue-label">Queued</span>
              <span className="queue-text">
                {message.text || `${message.attachments.length} attachment(s)`}
              </span>
              <button className="icon-button" title="Remove from queue" onClick={() => unqueue(chat.id, i)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div
        className="composer-box"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          if (e.dataTransfer.files.length === 0) return;
          e.preventDefault();
          void attachFiles([...e.dataTransfer.files]);
        }}
      >
        {suggestions.length > 0 && (
          <ul className="suggestions" role="listbox" aria-label={token?.kind === "file" ? "Files" : "Commands"}>
            {suggestions.map((s, i) => (
              <li key={s.insert} role="option" aria-selected={i === choice}>
                <button
                  className={i === choice ? "selected" : ""}
                  // Keep focus in the text field while choosing with the mouse.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => accept(s)}
                >
                  <span className="suggestion-label">{s.label}</span>
                  {s.detail && <span className="suggestion-detail">{s.detail}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {attachments.length > 0 && (
          <ul className="attachments">
            {attachments.map((a) => (
              <li key={a.path} title={a.path}>
                {a.preview ? <img src={a.preview} alt="" /> : <span className="file-glyph" aria-hidden />}
                <span className="attachment-name">{a.name}</span>
                <button
                  className="icon-button"
                  title="Remove attachment"
                  onClick={() => setAttachments(chat.id, attachments.filter((x) => x.path !== a.path))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={input}
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={(e) => change(e.target.value, e.target.selectionStart)}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const pasted = [...e.clipboardData.files];
            if (pasted.length === 0) return;
            e.preventDefault();
            void attachFiles(pasted);
          }}
        />
        <div className="composer-tools">
          <button className="button small" title="Attach files or images. You can also paste or drop them." onClick={browse}>
            Attach
          </button>
          <ModelPicker
            chat={chat}
            busy={busy}
            onPickAgent={canPickAgent ? (agent) => setChatAgent(chat.id, agent) : undefined}
          />
          {canPlan && (
            <label
              className="fast-toggle"
              title="Plan mode: Claude proposes a plan and waits for your approval before changing anything."
            >
              <input
                type="checkbox"
                checked={chat.plan}
                disabled={busy}
                onChange={(e) => setChatPlan(chat.id, e.target.checked)}
              />
              Plan
            </label>
          )}
          <span className="spacer" />
          {busy && (
            <button className="button" onClick={onStop}>
              Stop
            </button>
          )}
          <button
            className="button primary"
            disabled={empty}
            title={busy ? "Sent when the agent finishes its current turn" : undefined}
            onClick={submit}
          >
            {busy ? "Queue" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Whether a path names an image the agent can be shown. */
export const isImage = (path: string) => IMAGE.test(path);
