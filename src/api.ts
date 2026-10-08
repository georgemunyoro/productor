import { invoke } from "@tauri-apps/api/core";
import type {
  AgentDefaults,
  AgentEvent,
  AgentKind,
  Chat,
  ChatStatus,
  Group,
  HealthCheck,
  InboxItem,
  MyPullRequest,
  PermissionRequest,
  PrAction,
  PrStatus,
  Repo,
  SearchHit,
  Settings,
  StorageEntry,
  Workspace,
} from "./types";

/** Something that can be put in a group: a workspace or a quick chat. */
export interface Member {
  kind: "workspace" | "chat";
  id: string;
}

export interface AppSnapshot {
  repos: Repo[];
  workspaces: Workspace[];
  chats: Chat[];
  groups: Group[];
  inbox: InboxItem[];
  settings: Settings;
  /** By workspace id, or by chat id for a review chat with no workspace. */
  prs: Record<string, PrStatus>;
  statuses: Record<string, ChatStatus>;
  /** Requests each chat's agent is waiting on the user for. */
  permissions?: Record<string, PermissionRequest[]>;
  /** Background work that is currently failing, by what it is. */
  problems?: Record<string, string>;
  /** Why Claude Code refused fast mode, once it has. */
  claudeFastRefused?: string | null;
}

export const api = {
  getState: () => invoke<AppSnapshot>("get_state"),
  addRepo: (path: string) => invoke<Repo>("add_repo", { path }),
  removeRepo: (repoId: string) => invoke<void>("remove_repo", { repoId }),
  createWorkspace: (repoId: string) =>
    invoke<{ workspace: Workspace; chat: Chat }>("create_workspace", { repoId }),
  archiveWorkspace: (workspaceId: string) => invoke<void>("archive_workspace", { workspaceId }),
  createChat: (workspaceId: string) => invoke<Chat>("create_chat", { workspaceId }),
  createQuickChat: (repoId: string) => invoke<Chat>("create_quick_chat", { repoId }),
  promoteChat: (chatId: string) =>
    invoke<{ workspace: Workspace; chat: Chat }>("promote_chat", { chatId }),
  deleteChat: (chatId: string) => invoke<void>("delete_chat", { chatId }),
  renameChat: (chatId: string, title: string) => invoke<void>("rename_chat", { chatId, title }),
  renameWorkspace: (workspaceId: string, name: string) =>
    invoke<void>("rename_workspace", { workspaceId, name }),
  setChatAgent: (chatId: string, agent: AgentKind) =>
    invoke<void>("set_chat_agent", { chatId, agent }),
  warmUpChat: (chatId: string) => invoke<void>("warm_up_chat", { chatId }),
  setChatOptions: (chatId: string, model: string | null, fast: boolean | null) =>
    invoke<void>("set_chat_options", { chatId, model, fast }),
  agentDefaults: () => invoke<AgentDefaults>("agent_defaults"),
  markInboxRead: (itemId: string | null) => invoke<void>("mark_inbox_read", { itemId }),
  deleteInboxItem: (itemId: string) => invoke<void>("delete_inbox_item", { itemId }),
  startReview: (itemId: string) => invoke<string>("start_review", { itemId }),
  refreshInbox: () => invoke<void>("refresh_inbox"),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  /** `id` is a workspace id, or the id of a review chat with no workspace. */
  refreshPr: (id: string) => invoke<void>("refresh_pr", { workspaceId: id }),
  prAction: (workspaceId: string, chatId: string | null, action: PrAction) =>
    invoke<void>("pr_action", { workspaceId, chatId, action }),
  setAutoPr: (workspaceId: string, enabled: boolean) =>
    invoke<void>("set_auto_pr", { workspaceId, enabled }),
  mergeGroup: (groupId: string) => invoke<string[]>("merge_group", { groupId }),
  myPullRequests: () => invoke<MyPullRequest[]>("my_pull_requests"),
  openPrWorkspace: (repo: string, number: number) =>
    invoke<{ workspace: Workspace; chat: Chat | null }>("open_pr_workspace", { repo, number }),
  setAutoPush: (workspaceId: string, enabled: boolean) =>
    invoke<void>("set_auto_push", { workspaceId, enabled }),
  health: () => invoke<HealthCheck[]>("health"),
  storage: () => invoke<StorageEntry[]>("storage"),
  forkChat: (chatId: string, turn: number, withWorktree: boolean) =>
    invoke<{ chat: Chat; workspace: Workspace | null }>("fork_chat", { chatId, turn, withWorktree }),
  createGroup: (name: string) => invoke<Group>("create_group", { name }),
  renameGroup: (groupId: string, name: string) => invoke<void>("rename_group", { groupId, name }),
  deleteGroup: (groupId: string) => invoke<void>("delete_group", { groupId }),
  setGroup: (member: Member, groupId: string | null) =>
    invoke<void>("set_group", {
      workspaceId: member.kind === "workspace" ? member.id : null,
      chatId: member.kind === "chat" ? member.id : null,
      groupId,
    }),
  getTranscript: (chatId: string) => invoke<AgentEvent[]>("get_transcript", { chatId }),
  sendMessage: (chatId: string, text: string, attachments: string[] = []) =>
    invoke<void>("send_message", { chatId, text, attachments }),
  /** Stores pasted or dropped file contents and returns the saved path. */
  saveAttachment: (name: string, data: string) => invoke<string>("save_attachment", { name, data }),
  listChatFiles: (chatId: string) => invoke<string[]>("list_chat_files", { chatId }),
  answerQuestion: (chatId: string, requestId: string, answers: Record<string, string>) =>
    invoke<void>("answer_question", { chatId, requestId, answers }),
  setChatPlan: (chatId: string, plan: boolean) => invoke<void>("set_chat_plan", { chatId, plan }),
  searchChats: (query: string) => invoke<SearchHit[]>("search_chats", { query }),
  restoreWorkspace: (workspaceId: string) => invoke<void>("restore_workspace", { workspaceId }),
  setSetupScript: (repoId: string, script: string | null) =>
    invoke<void>("set_setup_script", { repoId, script }),
  setSettings: (settings: Settings) => invoke<void>("set_settings", { settings }),
  openWorkspace: (workspaceId: string, how: "editor" | "finder") =>
    invoke<void>("open_workspace", { workspaceId, with: how }),
  commitWorkspace: (workspaceId: string, message: string) =>
    invoke<void>("commit_workspace", { workspaceId, message }),
  pushWorkspace: (workspaceId: string) => invoke<void>("push_workspace", { workspaceId }),
  discardFile: (workspaceId: string, path: string) =>
    invoke<void>("discard_file", { workspaceId, path }),
  interrupt: (chatId: string) => invoke<void>("interrupt", { chatId }),
  respondPermission: (chatId: string, requestId: string, allow: boolean) =>
    invoke<void>("respond_permission", { chatId, requestId, allow }),
  setRunScript: (repoId: string, script: string | null) =>
    invoke<void>("set_run_script", { repoId, script }),
  getDiff: (workspaceId: string) =>
    invoke<{ base: string; diff: string; uncommitted: string[]; unpushed: number | null }>(
      "get_diff",
      { workspaceId },
    ),
  listFiles: (workspaceId: string) => invoke<string[]>("list_files", { workspaceId }),
  readFile: (workspaceId: string, path: string) =>
    invoke<string>("read_file", { workspaceId, path }),
  writeFile: (workspaceId: string, path: string, content: string) =>
    invoke<void>("write_file", { workspaceId, path, content }),
  termOpen: (workspaceId: string, cols: number, rows: number, command?: string) =>
    invoke<string>("term_open", { workspaceId, cols, rows, command }),
  termWrite: (id: string, data: string) => invoke<void>("term_write", { id, data }),
  termResize: (id: string, cols: number, rows: number) =>
    invoke<void>("term_resize", { id, cols, rows }),
  termClose: (id: string) => invoke<void>("term_close", { id }),
};
