export interface Repo {
  id: string;
  name: string;
  path: string;
  runScript: string | null;
  /** Command run in each new workspace, e.g. to install dependencies. */
  setupScript: string | null;
}

/** A pull request that a review chat or review workspace is about. */
export interface LinkedPr {
  /** `owner/name`. */
  repo: string;
  number: number;
}

export interface Workspace {
  id: string;
  repoId: string;
  name: string;
  branch: string;
  path: string;
  createdAt: number;
  archived: boolean;
  groupId: string | null;
  /** The agent looks after this workspace's pull request without being asked. */
  autoPr: boolean;
  /** Pushes to the workspace's own branch go ahead without asking. */
  autoPush: boolean;
  /** Set when the workspace exists to review someone else's pull request. */
  linkedPr: LinkedPr | null;
}

export interface Group {
  id: string;
  name: string;
}

export type AgentKind = "claude" | "codex";

export const AGENT_NAMES: Record<AgentKind, string> = { claude: "Claude", codex: "Codex" };

export interface Chat {
  id: string;
  agent: AgentKind;
  /** Null for a quick chat, which belongs to a repository instead. */
  workspaceId: string | null;
  repoId: string | null;
  cwd: string | null;
  title: string | null;
  sessionId: string | null;
  createdAt: number;
  turns: number;
  /** Only set on quick chats; a workspace's chats follow its group. */
  groupId: string | null;
  /** The agent plans and waits for approval before changing anything. */
  plan: boolean;
  /** The pull request this chat is reviewing, if it is a review. */
  linkedPr: LinkedPr | null;
  /** Model name as the agent's CLI knows it; null means the agent's own default. */
  model: string | null;
  /** Whether fast mode is asked for; null means the agent's own default. */
  fast: boolean | null;
  /** Set on a chat started from an inbox item; such chats are reached through the inbox. */
  inboxId: string | null;
}

export type ChatStatus = "idle" | "running" | "awaiting_permission";

/**
 * A transcript event: a line of Claude Code's stream-json output, a Codex event
 * translated into that shape, or one of our own `productor_*` events.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AgentEvent = { type: string } & Record<string, any>;

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** A pull request on GitHub that is waiting for the user's review. */
export interface InboxItem {
  id: string;
  kind: "review_request";
  /** `owner/name`. */
  repo: string;
  number: number;
  title: string;
  author: string;
  url: string;
  /** The agent's review chat, once one has been started. */
  chatId: string | null;
  status: "new" | "running" | "needs_approval" | "done" | "failed";
  /** The agent's findings, once it has finished. */
  summary: string;
  /** When Productor first saw the request. */
  createdAt: number;
  /** When the pull request last changed on GitHub (ISO timestamp). */
  updatedAt: string;
  read: boolean;
  /** Asked of you by name, rather than of a team you are on. */
  direct: boolean;
  /** Removed by the user; kept only so it does not reappear. */
  dismissed: boolean;
}

/** The state on GitHub of a workspace's pull request. */
export interface PrStatus {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  draft: boolean;
  ci: "passing" | "failing" | "pending" | "none";
  failingChecks: string[];
  review: "approved" | "changes_requested" | "review_required" | "none";
  /** Ids of review threads nobody has resolved. */
  unresolvedThreads: string[];
  mergeable: "mergeable" | "conflicting" | "unknown";
  headSha: string;
}

export type PrAction = "create_pr" | "fix_ci" | "address_comments" | "resolve_conflicts";

/** What each agent uses when a chat does not choose, from the agents' own config. */
export interface AgentDefaults {
  claudeModel: string | null;
  codexModel: string | null;
  codexFast: boolean;
}

export interface Settings {
  /** Bill an API key from the environment instead of the subscription login. */
  useApiKey: boolean;
  /** Command that opens a folder in the user's editor. */
  editor: string;
}

/** A slash command the agent accepts. */
export interface SlashCommand {
  name: string;
  description: string;
}

/** A file attached to a message that has not been sent yet. */
export interface Attachment {
  path: string;
  name: string;
  /** Data URL for showing an image before it is sent. */
  preview?: string;
}

export interface SearchHit {
  chatId: string;
  who: "you" | "agent";
  snippet: string;
}

/** One of the user's own open pull requests. */
export interface MyPullRequest {
  repo: string;
  number: number;
  title: string;
  url: string;
  draft: boolean;
  updatedAt: string;
}

export interface HealthCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** What to do about it, when it is not ok. */
  fix: string;
}

export interface StorageEntry {
  /** Null for a shared checkout that belongs to no workspace. */
  workspaceId: string | null;
  name: string;
  path: string;
  kb: number;
}
