import { api } from "../api";
import { useStore } from "../store";
import { AGENT_NAMES, type AgentKind, type LinkedPr, type Workspace } from "../types";
import { prChips } from "./PrStatusMarks";

/**
 * The strip under a chat's header showing its pull request. For a
 * workspace's own pull request it also offers what the agent can do about
 * it; for one that is only being reviewed, it shows its state and no more.
 */
export function PrBar(props: {
  /** What the status is tracked under: a workspace id, or a review chat's id. */
  ownerId: string;
  /** Absent for a read-only review chat. */
  workspace?: Workspace;
  /** Set when this is a review of someone else's pull request. */
  linked: LinkedPr | null;
  chatId: string | undefined;
  agent: AgentKind;
  busy: boolean;
}) {
  const { ownerId, workspace, linked, chatId, agent, busy } = props;
  const pr = useStore((s) => s.prs[ownerId]);
  const hasTurns = useStore((s) =>
    s.chats.some((c) => c.workspaceId === workspace?.id && c.turns > 0),
  );
  const { prAction, setAutoPr, setAutoPush, refreshPr, reportError } = useStore.getState();
  const name = AGENT_NAMES[agent];
  const busyTitle = busy ? `Wait for ${name} to finish its turn` : undefined;
  const openOnGitHub = (url: string) => api.openUrl(url).catch(reportError);
  const refresh = (
    <button className="icon-button" title="Check GitHub now" onClick={() => refreshPr(ownerId)}>
      ↻
    </button>
  );

  if (!pr) {
    if (linked) {
      // Known from the review request even before GitHub has been asked.
      return (
        <div className="pr-bar">
          <span className="chip tone-accent">Reviewing</span>
          <button
            className="pr-title"
            title="Open the pull request on GitHub"
            onClick={() => openOnGitHub(`https://github.com/${linked.repo}/pull/${linked.number}`)}
          >
            <strong>#{linked.number}</strong> in {linked.repo}
          </button>
          {refresh}
        </div>
      );
    }
    // Nothing to open a pull request for until the agent has done some work.
    if (!workspace || !hasTurns) return null;
    return (
      <div className="pr-bar">
        <span className="pr-title muted">No pull request yet</span>
        <button
          className="button small"
          disabled={busy}
          title={busyTitle}
          onClick={() => prAction(workspace.id, chatId ?? null, "create_pr")}
        >
          Have {name} open one
        </button>
      </div>
    );
  }

  // Fixing and auto-handling are for the user's own pull requests only.
  const own = workspace && !linked;
  const open = pr.state === "OPEN";
  const threads = pr.unresolvedThreads.length;
  return (
    <div className="pr-bar">
      {linked && <span className="chip tone-accent">Reviewing</span>}
      <button className="pr-title" title="Open the pull request on GitHub" onClick={() => openOnGitHub(pr.url)}>
        <strong>#{pr.number}</strong> {pr.title}
      </button>
      <span className="pr-chips">
        {prChips(pr).map((chip) => (
          <span key={chip.label} className={`chip tone-${chip.tone}`} title={chip.title}>
            {chip.label}
          </span>
        ))}
      </span>
      {own && open && pr.mergeable === "conflicting" && (
        <button
          className="button small"
          disabled={busy}
          title={busyTitle ?? `${name} merges the base branch in, resolves the conflicts, tests and pushes`}
          onClick={() => prAction(workspace.id, chatId ?? null, "resolve_conflicts")}
        >
          Resolve conflicts
        </button>
      )}
      {own && open && pr.ci === "failing" && (
        <button
          className="button small"
          disabled={busy}
          title={busyTitle}
          onClick={() => prAction(workspace.id, chatId ?? null, "fix_ci")}
        >
          Fix CI
        </button>
      )}
      {own && open && threads > 0 && (
        <button
          className="button small"
          disabled={busy}
          title={
            busyTitle ??
            `${name} makes the changes or drafts replies, and shows you before anything is pushed or posted`
          }
          onClick={() => prAction(workspace.id, chatId ?? null, "address_comments")}
        >
          Address {threads} comment{threads === 1 ? "" : "s"}
        </button>
      )}
      {own && open && (
        <label
          className="pr-auto"
          title={`${name} starts on merge conflicts, failing CI and new review comments without being asked. Posting to GitHub always waits for your approval; pushing does too unless “Push freely” is on.`}
        >
          <input
            type="checkbox"
            checked={workspace.autoPr}
            onChange={(e) => setAutoPr(workspace.id, e.target.checked)}
          />
          Auto
        </label>
      )}
      {own && open && agent === "claude" && (
        <label
          className="pr-auto"
          title={`${name} may push to this workspace's own branch without asking each time. Force pushes, merging and posting to GitHub still ask. With Auto on, this is what lets fixes land while you are away.`}
        >
          <input
            type="checkbox"
            checked={workspace.autoPush}
            onChange={(e) => setAutoPush(workspace.id, e.target.checked)}
          />
          Push freely
        </label>
      )}
      {refresh}
    </div>
  );
}
