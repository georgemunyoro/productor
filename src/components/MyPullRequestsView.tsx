import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { MyPullRequest } from "../types";
import { InboxTabs } from "./InboxTabs";
import { prChips } from "./PrStatusMarks";
import { SidebarToggle } from "./SidebarToggle";

function ago(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (Number.isNaN(minutes)) return "";
  if (minutes < 60) return `updated ${minutes}m ago`;
  if (minutes < 60 * 24) return `updated ${Math.round(minutes / 60)}h ago`;
  return `updated ${Math.round(minutes / (60 * 24))}d ago`;
}

/**
 * The user's own open pull requests. Opening one as a workspace puts its
 * branch in a worktree, which is what lets an agent look after it.
 */
export function MyPullRequestsView() {
  const [mine, setMine] = useState<MyPullRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prs = useStore((s) => s.prs);
  const workspaces = useStore((s) => s.workspaces);
  const opening = useStore((s) => s.openingPr);
  const { openPrWorkspace, selectWorkspace, reportError } = useStore.getState();

  const load = () => {
    setError(null);
    api.myPullRequests().then(setMine, (e) => {
      setMine([]);
      setError(String(e));
    });
  };
  useEffect(load, []);

  // A pull request is open here if some workspace of the user's own tracks it.
  const workspaceFor = (pr: MyPullRequest) =>
    workspaces.find((w) => !w.archived && !w.linkedPr && prs[w.id]?.url === pr.url);

  return (
    <div className="chat">
      <header className="chat-header" data-tauri-drag-region>
        <SidebarToggle whenSidebar="hidden" />
        <InboxTabs />
        <button className="button small header-action" disabled={mine === null} onClick={load}>
          {mine === null ? "Checking…" : "Check now"}
        </button>
      </header>
      {error && <div className="banner">Could not list your pull requests: {error}</div>}
      <div className="transcript">
        <div className="transcript-inner">
          {mine?.length === 0 && !error && (
            <p className="transcript-empty">You have no open pull requests.</p>
          )}
          {mine && mine.length > 0 && (
            <p className="hint">
              Open a pull request as a workspace to have an agent look after it: fix failing CI,
              resolve conflicts and respond to review comments.
            </p>
          )}
          <ul className="member-list">
            {mine?.map((pr) => {
              const workspace = workspaceFor(pr);
              const status = workspace ? prs[workspace.id] : undefined;
              const key = `${pr.repo}#${pr.number}`;
              return (
                <li key={key} className="inbox-item">
                  <div className="inbox-main">
                    <span className="inbox-top">
                      <span className="inbox-title">{pr.title}</span>
                    </span>
                    <span className="inbox-meta">
                      <span>
                        {pr.repo} #{pr.number} · {ago(pr.updatedAt)}
                      </span>
                      {status
                        ? prChips(status).map((chip) => (
                            <span key={chip.label} className={`chip tone-${chip.tone}`} title={chip.title}>
                              {chip.label}
                            </span>
                          ))
                        : pr.draft && <span className="chip">Draft</span>}
                      {workspace?.autoPr && <span className="chip tone-accent">Looked after</span>}
                    </span>
                    <span className="inbox-actions">
                      {workspace ? (
                        <button className="button small primary" onClick={() => selectWorkspace(workspace.id)}>
                          Open workspace
                        </button>
                      ) : (
                        <button
                          className="button small primary"
                          disabled={opening !== null}
                          title="Check this pull request's branch out in a new workspace"
                          onClick={() => openPrWorkspace(pr.repo, pr.number)}
                        >
                          {opening === key ? "Opening…" : "Open as workspace"}
                        </button>
                      )}
                      <button className="button small" onClick={() => api.openUrl(pr.url).catch(reportError)}>
                        Open on GitHub
                      </button>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
