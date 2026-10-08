import { useMemo, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { InboxItem } from "../types";
import { InboxTabs } from "./InboxTabs";
import { prChips } from "./PrStatusMarks";
import { SidebarToggle } from "./SidebarToggle";

const STATUS: Record<InboxItem["status"], { label: string; dot: string }> = {
  new: { label: "Not reviewed", dot: "idle" },
  running: { label: "Agent is reviewing", dot: "running" },
  needs_approval: { label: "Agent needs approval", dot: "awaiting_permission" },
  done: { label: "Agent review ready", dot: "done" },
  failed: { label: "Agent review failed", dot: "failed" },
};

type Sort = "updated" | "oldest" | "requested" | "repo" | "author";

interface Filters {
  text: string;
  /** Who the review was asked of. */
  asked: "all" | "me" | "team";
  repo: string;
  review: "all" | "none" | "started" | "unread";
  hideBots: boolean;
  sort: Sort;
}

const DEFAULTS: Filters = {
  text: "",
  asked: "all",
  repo: "all",
  review: "all",
  hideBots: false,
  sort: "updated",
};

const STORAGE_KEY = "inbox.filters";

function loadFilters(): Filters {
  try {
    // The search text is not worth carrying over between sessions.
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"), text: "" };
  } catch {
    return DEFAULTS;
  }
}

const isBot = (item: InboxItem) => item.author.endsWith("[bot]");

function matches(item: InboxItem, f: Filters): boolean {
  if (f.asked === "me" && !item.direct) return false;
  if (f.asked === "team" && item.direct) return false;
  if (f.repo !== "all" && item.repo !== f.repo) return false;
  if (f.review === "none" && item.chatId) return false;
  if (f.review === "started" && !item.chatId) return false;
  if (f.review === "unread" && item.read) return false;
  if (f.hideBots && isBot(item)) return false;
  const needle = f.text.trim().toLowerCase();
  if (!needle) return true;
  return `${item.title} ${item.repo} #${item.number} ${item.author}`.toLowerCase().includes(needle);
}

const COMPARE: Record<Sort, (a: InboxItem, b: InboxItem) => number> = {
  updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
  oldest: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
  requested: (a, b) => b.createdAt - a.createdAt || b.updatedAt.localeCompare(a.updatedAt),
  repo: (a, b) => a.repo.localeCompare(b.repo) || b.number - a.number,
  author: (a, b) => a.author.localeCompare(b.author, undefined, { sensitivity: "base" }) || b.number - a.number,
};

function ago(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 60) return `updated ${minutes}m ago`;
  if (minutes < 60 * 24) return `updated ${Math.round(minutes / 60)}h ago`;
  return `updated ${Math.round(minutes / (60 * 24))}d ago`;
}

export function InboxView() {
  const inbox = useStore((s) => s.inbox);
  const reviewingItemId = useStore((s) => s.reviewingItemId);
  const problem = useStore((s) => s.problems.inbox);
  const prs = useStore((s) => s.prs);
  const chats = useStore((s) => s.chats);
  // Live state of the pull request, known once a review has been started.
  const prOf = (item: InboxItem) => {
    const chat = chats.find((c) => c.id === item.chatId);
    return chat ? prs[chat.workspaceId ?? chat.id] : undefined;
  };
  const { reviewInboxItem, markInboxRead, deleteInboxItem, refreshInbox, reportError } =
    useStore.getState();
  const [refreshing, setRefreshing] = useState(false);
  const [filters, setFilters] = useState(loadFilters);

  const update = (patch: Partial<Filters>) => {
    const next = { ...filters, ...patch };
    setFilters(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Remembering the filters is a convenience only.
    }
  };

  const all = useMemo(() => inbox.filter((i) => !i.dismissed), [inbox]);
  const repos = useMemo(() => [...new Set(all.map((i) => i.repo))].sort(), [all]);
  // A remembered repository filter may name one with nothing waiting any more.
  const active = repos.includes(filters.repo) ? filters : { ...filters, repo: "all" };
  const items = useMemo(
    () => all.filter((i) => matches(i, active)).sort(COMPARE[active.sort]),
    [all, active],
  );
  const unread = all.filter((i) => !i.read).length;
  const filtered = items.length !== all.length;

  const refresh = async () => {
    setRefreshing(true);
    await refreshInbox();
    setRefreshing(false);
  };

  return (
    <div className="chat">
      <header className="chat-header" data-tauri-drag-region>
        <SidebarToggle whenSidebar="hidden" />
        <InboxTabs />
        <span className="chat-branch">
          {all.length === 0
            ? "nothing waiting"
            : `${filtered ? `${items.length} of ` : ""}${all.length} waiting, ${unread} unread`}
        </span>
        <button className="button small header-action" disabled={refreshing} onClick={refresh}>
          {refreshing ? "Checking…" : "Check now"}
        </button>
        <button className="button small" disabled={unread === 0} onClick={() => markInboxRead(null)}>
          Mark all read
        </button>
      </header>

      {problem && (
        <div className="banner">
          Could not check GitHub for review requests, so this list may be out of date: {problem}
        </div>
      )}
      {all.length > 0 && (
        <div className="filters">
          <input
            type="search"
            aria-label="Search the inbox"
            placeholder="Search title, repository, number or author…"
            value={filters.text}
            onChange={(e) => update({ text: e.target.value })}
          />
          <select
            aria-label="Who the review was asked of"
            value={active.asked}
            onChange={(e) => update({ asked: e.target.value as Filters["asked"] })}
          >
            <option value="all">Asked of anyone</option>
            <option value="me">Asked of me</option>
            <option value="team">Asked of my team</option>
          </select>
          {repos.length > 1 && (
            <select
              aria-label="Repository"
              value={active.repo}
              onChange={(e) => update({ repo: e.target.value })}
            >
              <option value="all">All repositories</option>
              {repos.map((repo) => (
                <option key={repo} value={repo}>
                  {repo}
                </option>
              ))}
            </select>
          )}
          <select
            aria-label="Agent review"
            value={active.review}
            onChange={(e) => update({ review: e.target.value as Filters["review"] })}
          >
            <option value="all">Any state</option>
            <option value="unread">Unread</option>
            <option value="none">No agent review yet</option>
            <option value="started">Has an agent review</option>
          </select>
          <label>
            <input
              type="checkbox"
              checked={active.hideBots}
              onChange={(e) => update({ hideBots: e.target.checked })}
            />
            Hide bots
          </label>
          <label>
            Sort
            <select value={active.sort} onChange={(e) => update({ sort: e.target.value as Sort })}>
              <option value="updated">Recently updated</option>
              <option value="oldest">Least recently updated</option>
              <option value="requested">Newest in inbox</option>
              <option value="repo">Repository</option>
              <option value="author">Author</option>
            </select>
          </label>
        </div>
      )}

      <div className="transcript">
        <div className="transcript-inner">
          {all.length === 0 && (
            <p className="transcript-empty">
              Pull requests waiting for your review appear here. Productor checks GitHub every
              couple of minutes while it is open.
            </p>
          )}
          {all.length > 0 && items.length === 0 && (
            <p className="transcript-empty">
              Nothing matches these filters.{" "}
              <button className="button small" onClick={() => update({ ...DEFAULTS, sort: filters.sort })}>
                Clear filters
              </button>
            </p>
          )}
          <ul className="member-list">
            {items.map((item) => (
              <li key={item.id} className={"inbox-item" + (item.read ? "" : " unread")}>
                <div className="inbox-main">
                  <span className="inbox-top">
                    <span className={`dot ${STATUS[item.status].dot}`} aria-hidden />
                    <span className="inbox-title">{item.title}</span>
                  </span>
                  <span className="inbox-meta">
                    <span>
                      {item.repo} #{item.number} · by {item.author}
                      {item.updatedAt && ` · ${ago(item.updatedAt)}`}
                    </span>
                    <span className={"chip" + (item.direct ? " direct" : "")}>
                      {item.direct ? "Asked of you" : "Asked of your team"}
                    </span>
                    <span className={`chip ${item.status}`}>{STATUS[item.status].label}</span>
                    {prOf(item) &&
                      prChips(prOf(item)!).map((chip) => (
                        <span key={chip.label} className={`chip tone-${chip.tone}`} title={chip.title}>
                          {chip.label}
                        </span>
                      ))}
                  </span>
                  {item.summary && <span className="inbox-summary">{item.summary}</span>}
                  <span className="inbox-actions">
                    <button
                      className="button small primary"
                      disabled={reviewingItemId !== null}
                      onClick={() => reviewInboxItem(item)}
                    >
                      {reviewingItemId === item.id
                        ? "Starting…"
                        : item.chatId
                          ? "Open agent review"
                          : "Have Claude review it"}
                    </button>
                    <button
                      className="button small"
                      onClick={() => {
                        if (!item.read) void markInboxRead(item.id);
                        api.openUrl(item.url).catch(reportError);
                      }}
                    >
                      Open on GitHub
                    </button>
                  </span>
                </div>
                <button
                  className="icon-button"
                  title="Remove from inbox"
                  onClick={() => deleteInboxItem(item.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
