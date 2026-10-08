import { confirm, open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import type { Member } from "../api";
import { usePanel } from "../panelStore";
import { groupStatus, useStore, workspaceStatus } from "../store";
import { tagStyle } from "../tags";
import { useUi } from "../ui";
import type { Chat, InboxItem, Workspace } from "../types";
import { InlineRename } from "./InlineRename";
import { PrMark } from "./PrStatusMarks";
import { SidebarToggle } from "./SidebarToggle";

const REVIEW_DOT: Record<InboxItem["status"], string> = {
  new: "idle",
  running: "running",
  needs_approval: "awaiting_permission",
  done: "done",
  failed: "failed",
};

const REVIEW_LABEL: Record<InboxItem["status"], string> = {
  new: "Not started",
  running: "Agent is reviewing",
  needs_approval: "Needs your approval",
  done: "Review ready",
  failed: "Review failed",
};

const DRAG_TYPE = "application/x-productor-member";

function dragProps(member: Member) {
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(member));
      e.dataTransfer.effectAllowed = "move";
    },
  };
}

/** Disclosure control for a sidebar section; remembers its state. */
function SectionToggle({ id, label }: { id: string; label: string }) {
  const collapsed = usePanel((s) => Boolean(s.collapsed[id]));
  return (
    <button
      className="section-toggle"
      aria-expanded={!collapsed}
      aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}`}
      title={collapsed ? "Expand" : "Collapse"}
      onClick={() => usePanel.getState().toggleSection(id)}
    >
      ▸
    </button>
  );
}

/** Makes an element accept dragged workspaces and quick chats. */
function useDropTarget(onDrop: (member: Member) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (e: React.DragEvent) => {
        setOver(false);
        const raw = e.dataTransfer.getData(DRAG_TYPE);
        if (!raw) return;
        e.preventDefault();
        onDrop(JSON.parse(raw) as Member);
      },
    },
  };
}

/** The keyboard and click alternative to dragging a row into a group. */
function GroupMenu({ member, current }: { member: Member; current: string | null }) {
  const groups = useStore((s) => s.groups);
  const { setGroup, createGroup } = useStore.getState();
  const [shown, setShown] = useState(false);
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!shown) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node))
        setShown(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [shown]);

  const pick = (action: () => Promise<void>) => {
    setShown(false);
    void action();
  };

  return (
    <span className="menu-anchor" ref={root}>
      <button
        className={"icon-button row-action" + (shown ? " open" : "")}
        title="Move to group"
        aria-haspopup="menu"
        aria-expanded={shown}
        onClick={() => setShown(!shown)}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path
            d="M1.8 4.2c0-.6.5-1 1-1h3l1.4 1.6h6c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {shown && (
        <div className="menu" role="menu">
          {groups.map((group) => (
            <button
              key={group.id}
              role="menuitemradio"
              aria-checked={group.id === current}
              className={group.id === current ? "checked" : ""}
              onClick={() => pick(() => setGroup(member, group.id))}
            >
              {group.name}
            </button>
          ))}
          {current && (
            <button role="menuitem" onClick={() => pick(() => setGroup(member, null))}>
              Remove from group
            </button>
          )}
          <button role="menuitem" onClick={() => pick(() => createGroup("New group", member))}>
            New group…
          </button>
        </div>
      )}
    </span>
  );
}

function WorkspaceRow({ workspace, detail }: { workspace: Workspace; detail: string }) {
  const selected = useStore((s) => s.selectedWorkspaceId === workspace.id);
  const status = useStore((s) => workspaceStatus(workspace.id, s.chats, s.statuses));
  const pr = useStore((s) => s.prs[workspace.id]);
  // Something happened in one of its chats while it was not on screen.
  const unread = useUi((u) =>
    useStore.getState().chats.some((c) => c.workspaceId === workspace.id && u.unread[c.id]),
  );
  const { selectWorkspace, archiveWorkspace, renameWorkspace } = useStore.getState();
  const [renaming, setRenaming] = useState(false);
  const member: Member = { kind: "workspace", id: workspace.id };

  const archive = async () => {
    const ok = await confirm(
      `The worktree at ${workspace.path} will be deleted. The branch ${workspace.branch} and its snapshots are kept.`,
      { title: `Archive ${workspace.name}?`, kind: "warning", okLabel: "Archive" },
    );
    if (ok) await archiveWorkspace(workspace.id);
  };

  return (
    <li>
      <div className={"workspace" + (selected ? " selected" : "")} {...dragProps(member)}>
        {renaming ? (
          <span className="workspace-main">
            <span className={`dot ${status}`} aria-hidden />
            <span className="workspace-text">
              <InlineRename
                className="rename-input"
                label="Workspace name"
                value={workspace.name}
                onDone={(name) => {
                  setRenaming(false);
                  if (name) void renameWorkspace(workspace.id, name);
                }}
              />
              <span className="workspace-branch">{detail}</span>
            </span>
          </span>
        ) : (
          <button
            className="workspace-main"
            title={`${workspace.name} (double-click to rename)`}
            onClick={() => selectWorkspace(workspace.id)}
            onDoubleClick={() => setRenaming(true)}
          >
            <span className={`dot ${status}`} aria-hidden />
            <span className="workspace-text">
              <span className="workspace-title">
                <span className="workspace-name">
                  {unread && !selected && <span className="unread-dot" aria-label="New activity" />}
                  {workspace.name}
                </span>
                {/* A review workspace's name already carries the number. */}
                {pr && <PrMark pr={pr} hideNumber={workspace.linkedPr !== null} />}
              </span>
              <span className="workspace-branch">{detail}</span>
            </span>
          </button>
        )}
        <GroupMenu member={member} current={workspace.groupId} />
        <button className="icon-button row-action" title="Archive workspace" onClick={archive}>
          ×
        </button>
      </div>
    </li>
  );
}

function QuickChatRow({ chat }: { chat: Chat }) {
  const selected = useStore((s) => s.selectedQuickChatId === chat.id);
  const status = useStore((s) => s.statuses[chat.id] ?? "idle");
  const { selectChat, deleteChat, renameChat } = useStore.getState();
  const [renaming, setRenaming] = useState(false);
  const unread = useUi((u) => Boolean(u.unread[chat.id]));
  const member: Member = { kind: "chat", id: chat.id };
  return (
    <li>
      <div className={"workspace quick" + (selected ? " selected" : "")} {...dragProps(member)}>
        {renaming ? (
          <span className="workspace-main">
            <span className={`dot ${status}`} aria-hidden />
            <InlineRename
              className="rename-input"
              label="Chat name"
              value={chat.title ?? ""}
              onDone={(title) => {
                setRenaming(false);
                if (title) void renameChat(chat.id, title);
              }}
            />
          </span>
        ) : (
          <button
            className="workspace-main"
            onClick={() => selectChat(chat.id)}
            onDoubleClick={() => setRenaming(true)}
          >
            <span className={`dot ${status}`} aria-hidden />
            <span className="workspace-name" title={`${chat.title} (double-click to rename)`}>
              {unread && !selected && <span className="unread-dot" aria-label="New activity" />}
              {chat.title}
            </span>
          </button>
        )}
        <GroupMenu member={member} current={chat.groupId} />
        <button
          className="icon-button row-action"
          title="Delete quick chat"
          onClick={() => deleteChat(chat.id)}
        >
          ×
        </button>
      </div>
    </li>
  );
}

function GroupSection({ groupId, name }: { groupId: string; name: string }) {
  const repos = useStore((s) => s.repos);
  const workspaces = useStore((s) => s.workspaces);
  const chats = useStore((s) => s.chats);
  const selected = useStore((s) => s.selectedGroupId === groupId);
  const status = useStore((s) => groupStatus(groupId, s.workspaces, s.chats, s.statuses));
  const collapsed = usePanel((s) => Boolean(s.collapsed[`group:${groupId}`]));
  const { selectGroup, setGroup } = useStore.getState();
  const drop = useDropTarget((member) => void setGroup(member, groupId));

  const members = workspaces.filter((w) => w.groupId === groupId && !w.archived);
  const quick = chats.filter(
    (c) => c.groupId === groupId && !c.workspaceId && c.title && !c.inboxId,
  );
  const repoName = (id: string) => repos.find((r) => r.id === id)?.name ?? "";

  return (
    <section
      className={"repo group" + (drop.over ? " drop-over" : "")}
      style={tagStyle(groupId)}
      {...drop.props}
    >
      <div className={"group-header" + (selected ? " selected" : "")}>
        <SectionToggle id={`group:${groupId}`} label={name} />
        <button className="group-main" title="Open group overview" onClick={() => selectGroup(groupId)}>
          <span className={`dot ${status}`} aria-hidden />
          <span className="group-name">{name}</span>
          <span className="group-count">{members.length + quick.length}</span>
        </button>
      </div>
      {!collapsed && (
        <ul>
          {members.map((ws) => (
            <WorkspaceRow key={ws.id} workspace={ws} detail={`${repoName(ws.repoId)} · ${ws.branch}`} />
          ))}
          {quick.map((chat) => (
            <QuickChatRow key={chat.id} chat={chat} />
          ))}
          {members.length + quick.length === 0 && (
            <li className="workspace creating">Drag workspaces or quick chats here.</li>
          )}
        </ul>
      )}
    </section>
  );
}

function RepoSection({ repoId }: { repoId: string }) {
  const repo = useStore((s) => s.repos.find((r) => r.id === repoId))!;
  const workspaces = useStore((s) => s.workspaces);
  const chats = useStore((s) => s.chats);
  const creatingWorkspaceIn = useStore((s) => s.creatingWorkspaceIn);
  const openingQuickChatIn = useStore((s) => s.openingQuickChatIn);
  const collapsed = usePanel((s) => Boolean(s.collapsed[`repo:${repoId}`]));
  const { removeRepo, createWorkspace, openQuickChat, setGroup } = useStore.getState();
  // Dropping onto a repository takes the item out of its group.
  const drop = useDropTarget((member) => void setGroup(member, null));

  const all = workspaces.filter((w) => w.repoId === repoId && !w.archived);
  // Review chats started from the inbox are reached from there instead.
  const allQuick = chats.filter((c) => c.repoId === repoId && c.title && !c.inboxId);
  const ungrouped = all.filter((w) => !w.groupId);
  const quick = allQuick.filter((c) => !c.groupId);

  return (
    <section
      className={"repo" + (drop.over ? " drop-over" : "")}
      style={tagStyle(repoId)}
      {...drop.props}
    >
      <header className="repo-header">
        <SectionToggle id={`repo:${repoId}`} label={repo.name} />
        <span className="swatch" aria-hidden />
        <span className="repo-name" title={repo.path}>
          {repo.name}
        </span>
        {all.length === 0 && allQuick.length === 0 && (
          <button
            className="icon-button"
            title="Remove repository from Productor"
            onClick={() => removeRepo(repo.id)}
          >
            ×
          </button>
        )}
        <button
          className="icon-button"
          title="Quick chat: ask about this repository, read-only, no workspace"
          onClick={() => openQuickChat(repo.id)}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path
              d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          className="icon-button"
          title="New workspace"
          disabled={creatingWorkspaceIn !== null}
          onClick={() => createWorkspace(repo.id)}
        >
          +
        </button>
      </header>
      <ul>
        {!collapsed &&
          ungrouped.map((ws) => <WorkspaceRow key={ws.id} workspace={ws} detail={ws.branch} />)}
        {/* Progress shows even when collapsed, so a click is never met with silence. */}
        {creatingWorkspaceIn === repo.id && (
          <li className="workspace creating">Creating workspace…</li>
        )}
        {openingQuickChatIn === repo.id && (
          <li className="workspace creating">Preparing quick chat…</li>
        )}
      </ul>
      {!collapsed && quick.length > 0 && (
        <ul>
          <li className="section-label">Quick chats</li>
          {quick.map((chat) => (
            <QuickChatRow key={chat.id} chat={chat} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function Sidebar() {
  const repos = useStore((s) => s.repos);
  const groups = useStore((s) => s.groups);
  const width = usePanel((s) => s.sidebarWidth);
  const view = useStore((s) => s.selectedView);
  const unread = useStore((s) => s.inbox.filter((i) => !i.read && !i.dismissed).length);
  const inbox = useStore((s) => s.inbox);
  // The chat on screen, whether it is a read-only chat or one in a workspace.
  const openChatId = useStore(
    (s) =>
      s.selectedQuickChatId ??
      (s.selectedWorkspaceId ? s.selectedChatIds[s.selectedWorkspaceId] : undefined),
  );
  const reviewsCollapsed = usePanel((s) => Boolean(s.collapsed.inbox));
  // Every review an agent has started stays here until it is archived.
  const reviews = inbox.filter((i) => i.chatId && !i.dismissed);
  const prs = useStore((s) => s.prs);
  const chats = useStore((s) => s.chats);
  // A review's pull request is tracked under its chat, or under the
  // workspace it was promoted into.
  const reviewPr = (chatId: string | null) => {
    const chat = chats.find((c) => c.id === chatId);
    return chat ? prs[chat.workspaceId ?? chat.id] : undefined;
  };
  const { addRepo, createGroup, selectView, reviewInboxItem, deleteInboxItem } = useStore.getState();

  const pickRepo = async () => {
    const path = await open({ directory: true, title: "Add a git repository" });
    if (typeof path === "string") await addRepo(path);
  };

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) =>
      usePanel.getState().setSidebarWidth(Math.max(180, Math.min(480, ev.clientX)));
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
  };

  return (
    <>
      <aside className="sidebar" style={{ width }}>
        <div className="titlebar sidebar-titlebar" data-tauri-drag-region>
          <SidebarToggle whenSidebar="shown" />
        </div>
        <div className="sidebar-scroll">
          <nav className="sidebar-nav">
            <div className={"nav-row" + (view === "inbox" ? " selected" : "")}>
              {reviews.length > 0 && <SectionToggle id="inbox" label="reviews" />}
              <button className="nav-main" onClick={() => selectView("inbox")}>
                <span className="nav-label">Inbox</span>
                {unread > 0 && (
                  <span className="badge-count" aria-label={`${unread} unread`}>
                    {unread}
                  </span>
                )}
              </button>
            </div>
            {reviews.length > 0 && !reviewsCollapsed && (
              <ul className="nav-children">
                {reviews.map((item) => (
                  <li key={item.id}>
                    <div className={"workspace quick" + (item.chatId === openChatId ? " selected" : "")}>
                      <button
                        className="workspace-main"
                        title={`${item.repo} #${item.number}: ${item.title}`}
                        onClick={() => reviewInboxItem(item)}
                      >
                        <span className={`dot ${REVIEW_DOT[item.status]}`} aria-hidden />
                        <span className="workspace-text">
                          <span className="workspace-title">
                            <span className="workspace-name">
                              #{item.number} {item.title}
                            </span>
                            {reviewPr(item.chatId) && <PrMark pr={reviewPr(item.chatId)!} hideNumber />}
                          </span>
                          <span className="workspace-branch">{REVIEW_LABEL[item.status]}</span>
                        </span>
                      </button>
                      <button
                        className="icon-button row-action"
                        title="Archive review: removes it from here and from the inbox"
                        onClick={() => deleteInboxItem(item.id)}
                      >
                        ×
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </nav>
          {groups.map((group) => (
            <GroupSection key={group.id} groupId={group.id} name={group.name} />
          ))}
          {repos.length === 0 && (
            <p className="sidebar-empty">Add a repository to create your first workspace.</p>
          )}
          {repos.map((repo) => (
            <RepoSection key={repo.id} repoId={repo.id} />
          ))}
        </div>
        <footer className="sidebar-footer">
          <button className="text-button" onClick={pickRepo}>
            + Add repository
          </button>
          <button className="text-button" onClick={() => createGroup("New group")}>
            + New group
          </button>
          <button
            className={"text-button" + (view === "settings" ? " selected" : "")}
            title="Settings (⌘,)"
            onClick={() => selectView("settings")}
          >
            Settings
          </button>
        </footer>
      </aside>
      <div className="resizer" onPointerDown={startResize} role="separator" aria-orientation="vertical" />
    </>
  );
}
