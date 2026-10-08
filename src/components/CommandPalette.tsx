import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { copyText } from "../clipboard";
import { conversationMarkdown } from "../exportChat";
import { usePanel } from "../panelStore";
import { useStore } from "../store";
import type { SearchHit } from "../types";
import { useUi } from "../ui";

interface Entry {
  key: string;
  section: string;
  label: string;
  detail?: string;
  run: () => void;
}

/** ⌘K: jump to anything, run an action, or search what was said in any chat. */
export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  if (!open) return null;
  return <Palette />;
}

function Palette() {
  const { repos, workspaces, chats, groups, selectedWorkspaceId } = useStore();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState(0);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const list = useRef<HTMLUListElement>(null);
  const close = () => useUi.getState().setPaletteOpen(false);

  // Conversations are searched on the backend, a moment after typing stops.
  useEffect(() => {
    const needle = query.trim();
    if (needle.length < 2) return setHits([]);
    const timer = setTimeout(() => {
      api.searchChats(needle).then(setHits, () => setHits([]));
    }, 180);
    return () => clearTimeout(timer);
  }, [query]);

  const entries = useMemo(() => {
    const store = useStore.getState();
    const all: Entry[] = [];
    const repoName = (id: string | null) => repos.find((r) => r.id === id)?.name ?? "";
    for (const ws of workspaces.filter((w) => !w.archived)) {
      all.push({
        key: `ws:${ws.id}`,
        section: "Workspaces",
        label: ws.name,
        detail: `${repoName(ws.repoId)} · ${ws.branch}`,
        run: () => store.selectWorkspace(ws.id),
      });
    }
    for (const chat of chats.filter((c) => c.title)) {
      const ws = workspaces.find((w) => w.id === chat.workspaceId);
      if (ws?.archived) continue;
      all.push({
        key: `chat:${chat.id}`,
        section: "Chats",
        label: chat.title!,
        detail: ws ? ws.name : `${repoName(chat.repoId)} · quick chat`,
        run: () => store.selectChat(chat.id),
      });
    }
    for (const group of groups) {
      all.push({ key: `group:${group.id}`, section: "Groups", label: group.name, run: () => store.selectGroup(group.id) });
    }
    const action = (label: string, run: () => void, detail?: string) =>
      all.push({ key: `action:${label}`, section: "Actions", label, detail, run });
    action("Inbox", () => store.selectView("inbox"));
    action("Settings", () => store.selectView("settings"), "⌘,");
    for (const repo of repos) {
      action(`New workspace in ${repo.name}`, () => void store.createWorkspace(repo.id));
      action(`Quick chat in ${repo.name}`, () => void store.openQuickChat(repo.id));
    }
    if (selectedWorkspaceId) {
      action("New chat in this workspace", () => void store.createChat(selectedWorkspaceId), "⌘T");
      action("Show or hide the side panel", usePanel.getState().toggle, "⌘J");
    }
    action("Show or hide the sidebar", usePanel.getState().toggleSidebar, "⌘B");
    action("Find in this chat", () => useUi.getState().setFindOpen(true), "⌘F");
    action("Check GitHub for review requests", () => void store.refreshInbox());
    action("Copy this conversation as Markdown", () => {
      const s = useStore.getState();
      const id = s.selectedQuickChatId ?? (s.selectedWorkspaceId ? s.selectedChatIds[s.selectedWorkspaceId] : undefined);
      const chat = s.chats.find((c) => c.id === id);
      if (chat) void copyText(conversationMarkdown(chat.title ?? "Conversation", s.transcripts[chat.id] ?? []));
    });
    return all;
  }, [repos, workspaces, chats, groups, selectedWorkspaceId]);

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matching = entries.filter((e) => {
      const text = `${e.label} ${e.detail ?? ""} ${e.section}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
    const store = useStore.getState();
    const found: Entry[] = hits.map((hit, i) => {
      const chat = chats.find((c) => c.id === hit.chatId);
      return {
        key: `hit:${hit.chatId}:${i}`,
        section: "In conversations",
        label: hit.snippet,
        detail: `${chat?.title ?? "Chat"} · ${hit.who === "you" ? "you" : "agent"}`,
        run: () => store.selectChat(hit.chatId),
      };
    });
    return [...matching.slice(0, 40), ...found];
  }, [entries, hits, query, chats]);

  const choice = Math.min(picked, shown.length - 1);

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [choice]);

  const run = (entry: Entry | undefined) => {
    if (!entry) return;
    close();
    entry.run();
  };

  let lastSection = "";
  return (
    <div className="palette-backdrop" onPointerDown={close}>
      <div
        className="palette"
        role="dialog"
        aria-label="Command palette"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          aria-label="Search workspaces, chats and actions"
          placeholder="Go to a workspace or chat, run an action, or search conversations…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPicked(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            else if (e.key === "Enter") run(shown[choice]);
            else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (shown.length === 0) return;
              const step = e.key === "ArrowDown" ? 1 : -1;
              setPicked((choice + step + shown.length) % shown.length);
            }
          }}
        />
        <ul ref={list} role="listbox">
          {shown.length === 0 && <li className="palette-empty">Nothing matches.</li>}
          {shown.map((entry, i) => {
            const heading = entry.section !== lastSection ? entry.section : null;
            lastSection = entry.section;
            return (
              <li key={entry.key} role="option" aria-selected={i === choice}>
                {heading && <div className="palette-section">{heading}</div>}
                <button
                  className={i === choice ? "selected" : ""}
                  onMouseMove={() => setPicked(i)}
                  onClick={() => run(entry)}
                >
                  <span className="palette-label">{entry.label}</span>
                  {entry.detail && <span className="palette-detail">{entry.detail}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
