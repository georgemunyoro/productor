import { confirm } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { useStore, workspaceStatus } from "../store";
import type { ChatStatus } from "../types";
import { SidebarToggle } from "./SidebarToggle";

const STATUS_LABEL: Record<ChatStatus, string> = {
  idle: "Idle",
  running: "Working",
  awaiting_permission: "Needs approval",
};

export function GroupView() {
  const group = useStore((s) => s.groups.find((g) => g.id === s.selectedGroupId));
  const repos = useStore((s) => s.repos);
  const workspaces = useStore((s) => s.workspaces);
  const chats = useStore((s) => s.chats);
  const statuses = useStore((s) => s.statuses);
  const { renameGroup, deleteGroup, archiveGroup, broadcast, selectWorkspace, selectChat } =
    useStore.getState();

  const [name, setName] = useState(group?.name ?? "");
  const [prompt, setPrompt] = useState("");
  const [outcome, setOutcome] = useState("");

  useEffect(() => {
    setName(group?.name ?? "");
    setOutcome("");
  }, [group?.id, group?.name]);

  if (!group) return null;

  const members = workspaces.filter((w) => w.groupId === group.id && !w.archived);
  const quick = chats.filter((c) => c.groupId === group.id && !c.workspaceId && c.title);
  const total = members.length + quick.length;

  const saveName = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== group.name) void renameGroup(group.id, trimmed);
    else setName(group.name);
  };

  const send = async () => {
    const text = prompt.trim();
    if (!text) return;
    const { sent, skipped } = await broadcast(group.id, text);
    if (sent > 0) setPrompt("");
    setOutcome(
      `Sent to ${sent} chat${sent === 1 ? "" : "s"}` +
        (skipped ? `; skipped ${skipped} that ${skipped === 1 ? "is" : "are"} mid-turn.` : "."),
    );
  };

  const archiveAll = async () => {
    const ok = await confirm(
      `This deletes the worktrees of all ${members.length} workspaces in “${group.name}” and removes the group. Branches and snapshots are kept.`,
      { title: "Archive the whole group?", kind: "warning", okLabel: "Archive all" },
    );
    if (ok) await archiveGroup(group.id);
  };

  return (
    <div className="chat">
      <header className="chat-header" data-tauri-drag-region>
        <SidebarToggle whenSidebar="hidden" />
        <input
          className="group-title"
          aria-label="Group name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
        <button
          className="button small header-action"
          disabled={members.length === 0}
          onClick={archiveAll}
        >
          Archive all
        </button>
        <button
          className="button small"
          title="Removes the group only; its workspaces and chats are kept"
          onClick={() => deleteGroup(group.id)}
        >
          Delete group
        </button>
      </header>

      <div className="transcript">
        <div className="transcript-inner">
          {total === 0 && (
            <p className="transcript-empty">
              This group is empty. Drag workspaces or quick chats onto it in the sidebar, or use
              the folder button on a row.
            </p>
          )}
          {total > 0 && (
            <ul className="member-list">
              {members.map((ws) => {
                const status = workspaceStatus(ws.id, chats, statuses);
                const repo = repos.find((r) => r.id === ws.repoId);
                return (
                  <li key={ws.id}>
                    <button className="member" onClick={() => selectWorkspace(ws.id)}>
                      <span className={`dot ${status}`} aria-hidden />
                      <span className="member-name">{ws.name}</span>
                      <span className="member-detail">
                        {repo?.name} · {ws.branch}
                      </span>
                      <span className="member-status">{STATUS_LABEL[status]}</span>
                    </button>
                  </li>
                );
              })}
              {quick.map((chat) => {
                const status = statuses[chat.id] ?? "idle";
                return (
                  <li key={chat.id}>
                    <button className="member" onClick={() => selectChat(chat.id)}>
                      <span className={`dot ${status}`} aria-hidden />
                      <span className="member-name">{chat.title}</span>
                      <span className="member-detail">quick chat</span>
                      <span className="member-status">{STATUS_LABEL[status]}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {outcome && <div className="notice">{outcome}</div>}
        </div>
      </div>

      <div className="composer">
        <div className="composer-box">
          <textarea
            rows={2}
            value={prompt}
            disabled={total === 0}
            placeholder="Send the same prompt to every chat in this group…"
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="button primary" disabled={!prompt.trim() || total === 0} onClick={send}>
            Send to all
          </button>
        </div>
      </div>
    </div>
  );
}
