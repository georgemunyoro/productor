export interface Repo {
  id: string;
  name: string;
  path: string;
  runScript: string | null;
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
