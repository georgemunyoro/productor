import { confirm, open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import type { Member } from "../api";
import { usePanel } from "../panelStore";
import { groupStatus, useStore, workspaceStatus } from "../store";
import type { Chat, Workspace } from "../types";
import { SidebarToggle } from "./SidebarToggle";

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
  const { selectWorkspace, archiveWorkspace } = useStore.getState();
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
        <button className="workspace-main" onClick={() => selectWorkspace(workspace.id)}>
          <span className={`dot ${status}`} aria-hidden />
          <span className="workspace-text">
            <span className="workspace-name">{workspace.name}</span>
            <span className="workspace-branch">{detail}</span>
          </span>
        </button>
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
  const { selectChat, deleteChat } = useStore.getState();
  const member: Member = { kind: "chat", id: chat.id };
  return (
    <li>
      <div className={"workspace quick" + (selected ? " selected" : "")} {...dragProps(member)}>
        <button className="workspace-main" onClick={() => selectChat(chat.id)}>
          <span className={`dot ${status}`} aria-hidden />
          <span className="workspace-name" title={chat.title ?? undefined}>
            {chat.title}
          </span>
        </button>
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
  const { selectGroup, setGroup } = useStore.getState();
  const drop = useDropTarget((member) => void setGroup(member, groupId));

  const members = workspaces.filter((w) => w.groupId === groupId && !w.archived);
  const quick = chats.filter((c) => c.groupId === groupId && !c.workspaceId && c.title);
  const repoName = (id: string) => repos.find((r) => r.id === id)?.name ?? "";

  return (
    <section className={"repo group" + (drop.over ? " drop-over" : "")} {...drop.props}>
      <button
        className={"group-header" + (selected ? " selected" : "")}
        title="Open group overview"
        onClick={() => selectGroup(groupId)}
      >
        <span className={`dot ${status}`} aria-hidden />
        <span className="group-name">{name}</span>
        <span className="group-count">{members.length + quick.length}</span>
      </button>
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
    </section>
  );
}

function RepoSection({ repoId }: { repoId: string }) {
  const repo = useStore((s) => s.repos.find((r) => r.id === repoId))!;
  const workspaces = useStore((s) => s.workspaces);
  const chats = useStore((s) => s.chats);
  const creatingWorkspaceIn = useStore((s) => s.creatingWorkspaceIn);
  const openingQuickChatIn = useStore((s) => s.openingQuickChatIn);
  const { removeRepo, createWorkspace, openQuickChat, setGroup } = useStore.getState();
  // Dropping onto a repository takes the item out of its group.
  const drop = useDropTarget((member) => void setGroup(member, null));

  const all = workspaces.filter((w) => w.repoId === repoId && !w.archived);
  const allQuick = chats.filter((c) => c.repoId === repoId && c.title);
  const ungrouped = all.filter((w) => !w.groupId);
  const quick = allQuick.filter((c) => !c.groupId);

  return (
    <section className={"repo" + (drop.over ? " drop-over" : "")} {...drop.props}>
      <header className="repo-header">
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
        {ungrouped.map((ws) => (
          <WorkspaceRow key={ws.id} workspace={ws} detail={ws.branch} />
        ))}
        {creatingWorkspaceIn === repo.id && (
          <li className="workspace creating">Creating workspace…</li>
        )}
        {openingQuickChatIn === repo.id && (
          <li className="workspace creating">Preparing quick chat…</li>
        )}
      </ul>
      {quick.length > 0 && (
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
  const { addRepo, createGroup } = useStore.getState();

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
        </footer>
      </aside>
      <div className="resizer" onPointerDown={startResize} role="separator" aria-orientation="vertical" />
    </>
  );
}
