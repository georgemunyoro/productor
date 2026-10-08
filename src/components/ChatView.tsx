import { confirm } from "@tauri-apps/plugin-dialog";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import { copyText } from "../clipboard";
import { conversationMarkdown } from "../exportChat";
import { usePanel } from "../panelStore";
import { useStore } from "../store";
import { tagStyle } from "../tags";
import { AGENT_NAMES, type Chat, type Workspace } from "../types";
import { useUi } from "../ui";
import { Composer } from "./Composer";
import { FindBar } from "./FindBar";
import { InlineRename } from "./InlineRename";
import { PrBar } from "./PrBar";
import { RequestCard } from "./RequestCards";
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
  const permissions = useStore((s) => (chatId ? s.permissions[chatId] : undefined)) ?? [];
  const unread = useUi((s) => s.unread);
  const {
    createChat,
    selectChat,
    sendMessage,
    interrupt,
    respondPermission,
    answerQuestion,
    promoteChat,
    forkChat,
    closeChat,
    newChatLike,
  } = useStore.getState();
  const panelOpen = usePanel((s) => s.open);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // Whether the view is following new output. It stops when the user scrolls
  // up and resumes when they return to the bottom; nothing else changes it.
  const pinned = useRef(true);
  const lastTop = useRef(0);
  const [away, setAway] = useState(false);

  const toBottom = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  };

  const follow = () => {
    pinned.current = true;
    setAway(false);
    toBottom();
  };

  useLayoutEffect(() => {
    if (pinned.current) toBottom();
  }, [events, permissions.length, status]);

  useEffect(follow, [chatId]);

  // The transcript also changes size for reasons that are not new events:
  // the composer growing, the pull request bar appearing, the window or the
  // side panel being resized, content finishing its layout. Keep following
  // through all of those.
  const hasTranscript = Boolean(workspace || quickChat);
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) toBottom();
    });
    observer.observe(el);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [chatId, hasTranscript]);

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
  // Codex can only fork a whole thread, so only its latest turn is a valid
  // fork point, and only once it has finished.
  const canFork = (turn: number) => agent === "claude" || (turn === chat?.turns && !busy);

  const close = async (target: Chat, label: string) => {
    if (target.turns > 0 || target.title) {
      const ok = await confirm(`“${label}” and its conversation will be deleted.`, {
        title: "Close this chat?",
        kind: "warning",
        okLabel: "Close chat",
      });
      if (!ok) return;
    }
    await closeChat(target.id);
  };

  // Editing a message means going back to before it: a fork from the turn
  // that ended just before, or a fresh chat if it was the first message.
  const edit = (turn: number, text: string) => {
    if (!chatId) return;
    if (turn > 1 && canFork(turn - 1)) void forkChat(chatId, turn - 1, false, text);
    else void newChatLike(chatId, text);
  };

  return (
    <div className="chat">
      {workspace ? (
        <header className="chat-header" data-tauri-drag-region>
          <SidebarToggle whenSidebar="hidden" />
          <div className="chat-heading" data-tauri-drag-region>
            {renamingId === workspace.id ? (
              <InlineRename
                className="rename-input heading"
                label="Workspace name"
                value={workspace.name}
                onDone={(name) => {
                  setRenamingId(null);
                  if (name) void useStore.getState().renameWorkspace(workspace.id, name);
                }}
              />
            ) : (
              <strong title="Double-click to rename" onDoubleClick={() => setRenamingId(workspace.id)}>
                {workspace.name}
              </strong>
            )}
            <span className="chat-branch tagged" style={tagStyle(workspace.repoId)}>
              {workspace.branch}
            </span>
          </div>
          <nav className="tabs">
            {workspaceChats.map((tab, i) =>
              tab.id === renamingId ? (
                <InlineRename
                  key={tab.id}
                  className="tab selected"
                  label="Chat name"
                  value={tab.title ?? ""}
                  onDone={(title) => {
                    setRenamingId(null);
                    if (title) void useStore.getState().renameChat(tab.id, title);
                  }}
                />
              ) : (
                <span key={tab.id} className={"tab closable" + (tab.id === chatId ? " selected" : "")}>
                  <button
                    onClick={() => selectChat(tab.id)}
                    onDoubleClick={() => setRenamingId(tab.id)}
                    title={`${tab.title ?? chatLabel(tab, i)} (double-click to rename)`}
                  >
                    {unread[tab.id] && tab.id !== chatId && (
                      <span className="unread-dot" aria-label="New activity" />
                    )}
                    {chatLabel(tab, i)}
                  </button>
                  <button
                    className="tab-close"
                    title="Close chat"
                    onClick={() => close(tab, chatLabel(tab, i))}
                  >
                    ×
                  </button>
                </span>
              ),
            )}
            <button className="icon-button" title="New chat (⌘T)" onClick={() => createChat(workspace.id)}>
              +
            </button>
          </nav>
          <WorkspaceMenu workspace={workspace} />
          <button
            className={"button small" + (panelOpen ? " active" : "")}
            title="Show or hide changes, files and terminal (⌘J)"
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

      {workspace ? (
        <PrBar
          ownerId={workspace.id}
          workspace={workspace}
          linked={workspace.linkedPr}
          chatId={chatId}
          agent={agent}
          busy={busy}
        />
      ) : (
        quickChat?.linkedPr && (
          <PrBar
            ownerId={quickChat.id}
            linked={quickChat.linkedPr}
            chatId={chatId}
            agent={agent}
            busy={busy}
          />
        )
      )}

      <div className="transcript-wrap">
        <FindBar />
        <div
          className="transcript"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            // Only moving up counts as leaving. The view shrinking, or
            // content growing, changes the distance to the bottom without
            // the user having gone anywhere.
            if (atBottom) pinned.current = true;
            else if (el.scrollTop < lastTop.current - 2) pinned.current = false;
            lastTop.current = el.scrollTop;
            setAway(!pinned.current);
          }}
        >
          <div className="transcript-inner" ref={content}>
            {!chat && workspace && (
              <p className="transcript-empty">
                This workspace has no chats.{" "}
                <button className="button small" onClick={() => createChat(workspace.id)}>
                  New chat
                </button>
              </p>
            )}
            {chat && events && events.length === 0 && !busy && (
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
            {chatId && events && (
              <Transcript
                chatId={chatId}
                events={events}
                workspacePath={root}
                canFork={canFork}
                onFork={forking ? undefined : (turn, withWorktree) => forkChat(chatId, turn, withWorktree)}
                onEdit={forking ? undefined : edit}
                onRetry={busy ? undefined : (text, attachments) => sendMessage(chatId, text, attachments)}
              />
            )}
            {chatId &&
              permissions.map((request) => (
                <RequestCard
                  key={request.requestId}
                  request={request}
                  agent={agent}
                  onRespond={(allow) => respondPermission(chatId, request.requestId, allow)}
                  onAnswer={(answers) => answerQuestion(chatId, request.requestId, answers)}
                />
              ))}
            {status === "running" && <div className="working">Working…</div>}
          </div>
        </div>
        {away && (
          <button className="button small jump-latest" onClick={follow}>
            ↓ Latest
          </button>
        )}
      </div>

      {chat && (
        <Composer
          // Each chat gets its own composer, so one chat's file list and
          // caret never carry over into another.
          key={chat.id}
          chat={chat}
          busy={busy}
          placeholder={
            workspace ? `Ask ${AGENT_NAMES[agent]} to do something…` : "Ask about this repository…"
          }
          // The agents cannot read each other's sessions, so the agent is
          // fixed once the conversation has started.
          canPickAgent={chat.turns === 0 && !chat.title}
          onStop={() => interrupt(chat.id)}
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

/** Things to do with a workspace's folder, behind a "⋯" button. */
function WorkspaceMenu({ workspace }: { workspace: Workspace }) {
  const [shown, setShown] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const editor = useStore((s) => s.settings.editor);
  const { reportError } = useStore.getState();

  useEffect(() => {
    if (!shown) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node)) {
        setShown(false);
      }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [shown]);

  const run = (action: () => Promise<unknown>) => {
    setShown(false);
    action().catch(reportError);
  };

  return (
    <span className="menu-anchor header-action" ref={root}>
      <button
        className="icon-button"
        title="Open in editor, reveal in Finder, copy path…"
        aria-haspopup="menu"
        aria-expanded={shown}
        onClick={() => setShown(!shown)}
      >
        ⋯
      </button>
      {shown && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={() => run(() => api.openWorkspace(workspace.id, "editor"))}>
            Open in editor{editor ? ` (${editor})` : ""}
          </button>
          <button role="menuitem" onClick={() => run(() => api.openWorkspace(workspace.id, "finder"))}>
            Reveal in Finder
          </button>
          <button role="menuitem" onClick={() => run(() => copyText(workspace.path))}>
            Copy path
          </button>
          <button role="menuitem" onClick={() => run(() => copyText(workspace.branch))}>
            Copy branch name
          </button>
          <button
            role="menuitem"
            onClick={() =>
              run(async () => {
                const s = useStore.getState();
                const chatId = s.selectedChatIds[workspace.id];
                const chat = s.chats.find((c) => c.id === chatId);
                if (!chat) return;
                await copyText(conversationMarkdown(chat.title ?? workspace.name, s.transcripts[chat.id] ?? []));
              })
            }
          >
            Copy conversation as Markdown
          </button>
        </div>
      )}
    </span>
  );
}
