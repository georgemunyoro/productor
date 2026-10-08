import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePanel } from "../panelStore";
import { useStore } from "../store";
import { AGENT_NAMES, type AgentKind, type Chat, type PermissionRequest } from "../types";
import { SidebarToggle } from "./SidebarToggle";
import { Transcript } from "./Transcript";

export function ChatView() {
  const workspace = useStore((s) => s.workspaces.find((w) => w.id === s.selectedWorkspaceId));
  const chats = useStore((s) => s.chats);
  const quickChat = useStore((s) => s.chats.find((c) => c.id === s.selectedQuickChatId));
  const quickRepo = useStore((s) => s.repos.find((r) => r.id === quickChat?.repoId));
  const promoting = useStore((s) => s.promotingChatId !== null);
  const forking = useStore((s) => s.forkingChatId !== null);
  const chatId = useStore(
    (s) =>
      s.selectedQuickChatId ??
      (s.selectedWorkspaceId ? s.selectedChatIds[s.selectedWorkspaceId] : undefined),
  );
  const chat = chats.find((c) => c.id === chatId);
  const agent = chat?.agent ?? "claude";
  const status = useStore((s) => (chatId ? (s.statuses[chatId] ?? "idle") : "idle"));
  const events = useStore((s) => (chatId ? s.transcripts[chatId] : undefined));
  const partial = useStore((s) => (chatId ? (s.partials[chatId] ?? "") : ""));
  const permissions = useStore((s) => (chatId ? s.permissions[chatId] : undefined)) ?? [];
  const {
    createChat,
    selectChat,
    sendMessage,
    interrupt,
    respondPermission,
    promoteChat,
    forkChat,
    setChatAgent,
  } = useStore.getState();

  const panelOpen = usePanel((s) => s.open);

  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follow new output only while the user is already at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [events, partial, permissions.length]);

  useEffect(() => {
    pinned.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatId]);

  if (!workspace && !quickChat) {
    return (
      <div className="empty">
        <div className="titlebar" data-tauri-drag-region>
          <SidebarToggle whenSidebar="hidden" />
        </div>
        <p>Select a workspace, or create one with + next to a repository.</p>
      </div>
    );
  }

  const workspaceChats = workspace ? chats.filter((c) => c.workspaceId === workspace.id) : [];
  const busy = status !== "idle";
  const root = workspace?.path ?? quickChat?.cwd ?? "";

  return (
    <div className="chat">
      {workspace ? (
        <header className="chat-header" data-tauri-drag-region>
          <SidebarToggle whenSidebar="hidden" />
          <div className="chat-heading" data-tauri-drag-region>
            <strong>{workspace.name}</strong>
            <span className="chat-branch">{workspace.branch}</span>
          </div>
          <nav className="tabs">
            {workspaceChats.map((chat, i) => (
              <button
                key={chat.id}
                className={"tab" + (chat.id === chatId ? " selected" : "")}
                onClick={() => selectChat(chat.id)}
                title={chat.title ?? undefined}
              >
                {chatLabel(chat, i)}
              </button>
            ))}
            <button className="icon-button" title="New chat" onClick={() => createChat(workspace.id)}>
              +
            </button>
          </nav>
          <button
            className={"button small header-action" + (panelOpen ? " active" : "")}
            title="Show or hide changes, files and terminal"
            aria-pressed={panelOpen}
            onClick={usePanel.getState().toggle}
          >
            Panel
          </button>
        </header>
      ) : (
        <header className="chat-header" data-tauri-drag-region>
          <SidebarToggle whenSidebar="hidden" />
          <div className="chat-heading" data-tauri-drag-region>
            <strong>{quickRepo?.name}</strong>
            <span className="chat-branch">quick chat · read-only</span>
          </div>
          <button
            className="button small header-action"
            disabled={busy || promoting}
            title="Create a workspace and continue this conversation there, with the agent able to make changes"
            onClick={() => chatId && promoteChat(chatId)}
          >
            {promoting ? "Promoting…" : "Promote to workspace"}
          </button>
        </header>
      )}

      <div
        className="transcript"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        <div className="transcript-inner">
          {events && events.length === 0 && !busy && (
            <p className="transcript-empty">
              {workspace ? (
                <>
                  {AGENT_NAMES[agent]} runs in <code>{root}</code>. Ask it for something.
                </>
              ) : (
                <>
                  Ask anything about {quickRepo?.name}. Quick chats read <code>{root}</code> and
                  cannot change it.
                </>
              )}
            </p>
          )}
          {events && (
            <Transcript
              events={events}
              partial={partial}
              workspacePath={root}
              // Codex can only fork a whole thread, so only its latest turn
              // is a valid fork point, and only once it has finished.
              canFork={(turn) => agent === "claude" || (turn === chat?.turns && !busy)}
              onFork={
                chatId && !forking
                  ? (turn, withWorktree) => forkChat(chatId, turn, withWorktree)
                  : undefined
              }
            />
          )}
          {chatId &&
            permissions.map((request) => (
              <PermissionCard
                key={request.requestId}
                request={request}
                onAnswer={(allow) => respondPermission(chatId, request.requestId, allow)}
              />
            ))}
          {status === "running" && <div className="working">Working…</div>}
        </div>
      </div>

      {chatId && (
        <Composer
          key={chatId}
          busy={busy}
          placeholder={
            workspace ? `Ask ${AGENT_NAMES[agent]} to do something…` : "Ask about this repository…"
          }
          agent={agent}
          // The agents cannot read each other's sessions, so the choice is
          // fixed once the conversation has started.
          onPickAgent={
            chat && chat.turns === 0 && !chat.title && !busy
              ? (picked) => setChatAgent(chat.id, picked)
              : undefined
          }
          onSend={(text) => sendMessage(chatId, text)}
          onStop={() => interrupt(chatId)}
        />
      )}
    </div>
  );
}

function chatLabel(chat: Chat, index: number) {
  const suffix = chat.agent === "codex" ? " · Codex" : "";
  if (!chat.title) return `Chat ${index + 1}${suffix}`;
  return (chat.title.length > 28 ? chat.title.slice(0, 27) + "…" : chat.title) + suffix;
}

function PermissionCard(props: { request: PermissionRequest; onAnswer: (allow: boolean) => void }) {
  const { request, onAnswer } = props;
  const detail =
    typeof request.input.command === "string"
      ? request.input.command
      : JSON.stringify(request.input, null, 2);
  return (
    <div className="permission">
      <div className="permission-title">Claude wants to run {request.toolName}</div>
      <pre>{detail}</pre>
      <div className="permission-actions">
        <button className="button" onClick={() => onAnswer(false)}>
          Deny
        </button>
        <button className="button primary" onClick={() => onAnswer(true)}>
          Allow
        </button>
      </div>
    </div>
  );
}

function Composer(props: {
  busy: boolean;
  placeholder: string;
  agent: AgentKind;
  /** Present while the agent can still be changed. */
  onPickAgent?: (agent: AgentKind) => void;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const { busy, placeholder, agent, onPickAgent, onSend, onStop } = props;
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => input.current?.focus(), []);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  }, [text]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    onSend(trimmed);
    setText("");
  };

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          ref={input}
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {onPickAgent ? (
          <select
            className="agent-picker"
            aria-label="Agent"
            value={agent}
            onChange={(e) => onPickAgent(e.target.value as AgentKind)}
          >
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
        ) : (
          <span className="agent-label">{AGENT_NAMES[agent]}</span>
        )}
        {busy ? (
          <button className="button" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button className="button primary" disabled={!text.trim()} onClick={submit}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
