import { invoke } from "@tauri-apps/api/core";
import type { AgentEvent, AgentKind, Chat, ChatStatus, Group, Repo, Workspace } from "./types";

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
  statuses: Record<string, ChatStatus>;
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
  setChatAgent: (chatId: string, agent: AgentKind) =>
    invoke<void>("set_chat_agent", { chatId, agent }),
  warmUpChat: (chatId: string) => invoke<void>("warm_up_chat", { chatId }),
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
  sendMessage: (chatId: string, text: string) => invoke<void>("send_message", { chatId, text }),
  interrupt: (chatId: string) => invoke<void>("interrupt", { chatId }),
  respondPermission: (chatId: string, requestId: string, allow: boolean) =>
    invoke<void>("respond_permission", { chatId, requestId, allow }),
  setRunScript: (repoId: string, script: string | null) =>
    invoke<void>("set_run_script", { repoId, script }),
  getDiff: (workspaceId: string) =>
    invoke<{ base: string; diff: string }>("get_diff", { workspaceId }),
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
