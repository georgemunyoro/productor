import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { api, type Member } from "./api";
import type {
  AgentEvent,
  AgentKind,
  Chat,
  ChatStatus,
  Group,
  PermissionRequest,
  Repo,
  Workspace,
} from "./types";

interface AppStore {
  repos: Repo[];
  workspaces: Workspace[];
  chats: Chat[];
  groups: Group[];
  statuses: Record<string, ChatStatus>;
  selectedWorkspaceId: string | null;
  /** Set while a quick chat is shown instead of a workspace. */
  selectedQuickChatId: string | null;
  /** Set while a group's overview is shown. */
  selectedGroupId: string | null;
  promotingChatId: string | null;
  forkingChatId: string | null;
  openingQuickChatIn: string | null;
  /** Last chat viewed in each workspace. */
  selectedChatIds: Record<string, string>;
  transcripts: Record<string, AgentEvent[]>;
  /** Assistant text streamed so far for the message in flight. */
  partials: Record<string, string>;
  permissions: Record<string, PermissionRequest[]>;
  creatingWorkspaceIn: string | null;
  error: string | null;

  init: () => Promise<void>;
  refresh: () => Promise<void>;
  addRepo: (path: string) => Promise<void>;
  removeRepo: (repoId: string) => Promise<void>;
  createWorkspace: (repoId: string) => Promise<void>;
  archiveWorkspace: (workspaceId: string) => Promise<void>;
  selectWorkspace: (workspaceId: string) => void;
  createChat: (workspaceId: string) => Promise<void>;
  selectChat: (chatId: string) => void;
  openQuickChat: (repoId: string) => Promise<void>;
  promoteChat: (chatId: string) => Promise<void>;
  deleteChat: (chatId: string) => Promise<void>;
  setChatAgent: (chatId: string, agent: AgentKind) => Promise<void>;
  forkChat: (chatId: string, turn: number, withWorktree: boolean) => Promise<void>;
  selectGroup: (groupId: string) => void;
  createGroup: (name: string, first?: Member) => Promise<void>;
  renameGroup: (groupId: string, name: string) => Promise<void>;
  deleteGroup: (groupId: string) => Promise<void>;
  setGroup: (member: Member, groupId: string | null) => Promise<void>;
  archiveGroup: (groupId: string) => Promise<void>;
  broadcast: (groupId: string, text: string) => Promise<{ sent: number; skipped: number }>;
  sendMessage: (chatId: string, text: string) => Promise<void>;
  interrupt: (chatId: string) => Promise<void>;
  respondPermission: (chatId: string, requestId: string, allow: boolean) => Promise<void>;
  dismissError: () => void;
  reportError: (e: unknown) => void;
}

const PREFERRED_AGENT = "agent.preferred";

/** The agent new chats start with: whichever the user picked last. */
function preferredAgent(): AgentKind {
  try {
    return localStorage.getItem(PREFERRED_AGENT) === "codex" ? "codex" : "claude";
  } catch {
    return "claude";
  }
}

/** Gives a newly created chat the preferred agent and gets it ready. */
async function prepareChat(chat: Chat) {
  if (preferredAgent() !== chat.agent) await api.setChatAgent(chat.id, preferredAgent());
  else await api.warmUpChat(chat.id);
}

// Transcripts are loaded lazily. Events that arrive while a load is in flight
// may or may not be in the result, so the load is simply repeated.
const loading = new Set<string>();
const stale = new Set<string>();

export const useStore = create<AppStore>((set, get) => {
  const fail = (e: unknown) => set({ error: String(e) });

  const loadTranscript = async (chatId: string) => {
    if (loading.has(chatId) || get().transcripts[chatId]) return;
    loading.add(chatId);
    try {
      let events: AgentEvent[];
      do {
        stale.delete(chatId);
        events = await api.getTranscript(chatId);
      } while (stale.has(chatId));
      set((s) => ({ transcripts: { ...s.transcripts, [chatId]: events } }));
    } catch (e) {
      fail(e);
    } finally {
      loading.delete(chatId);
    }
  };

  const onAgentEvent = (chatId: string, event: AgentEvent) => {
    if (event.type === "stream_event") {
      if (event.parent_tool_use_id) return;
      const inner = event.event;
      if (inner?.type === "message_start") {
        set((s) => ({ partials: { ...s.partials, [chatId]: "" } }));
      } else if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta") {
        set((s) => ({
          partials: { ...s.partials, [chatId]: (s.partials[chatId] ?? "") + inner.delta.text },
        }));
      }
      return;
    }
    if (event.type === "control_request") {
      const request: PermissionRequest = {
        requestId: event.request_id,
        toolName: event.request.tool_name,
        input: event.request.input ?? {},
      };
      set((s) => ({
        permissions: { ...s.permissions, [chatId]: [...(s.permissions[chatId] ?? []), request] },
      }));
      return;
    }
    if (loading.has(chatId)) stale.add(chatId);
    set((s) => {
      const transcript = s.transcripts[chatId];
      const partials =
        event.type === "assistant" && !event.parent_tool_use_id
          ? { ...s.partials, [chatId]: "" }
          : s.partials;
      if (!transcript) return { partials };
      return { partials, transcripts: { ...s.transcripts, [chatId]: [...transcript, event] } };
    });
    // Titles and turn counts change on the backend as a chat progresses.
    if (event.type === "productor_user" || event.type === "result") void get().refresh();
  };

  const select = (workspaceId: string, chatId?: string) => {
    const chat =
      chatId ??
      get().selectedChatIds[workspaceId] ??
      get().chats.find((c) => c.workspaceId === workspaceId)?.id;
    set((s) => ({
      selectedWorkspaceId: workspaceId,
      selectedQuickChatId: null,
      selectedGroupId: null,
      selectedChatIds: chat ? { ...s.selectedChatIds, [workspaceId]: chat } : s.selectedChatIds,
    }));
    if (chat) void loadTranscript(chat);
  };

  const selectQuick = (chatId: string) => {
    set({ selectedQuickChatId: chatId, selectedWorkspaceId: null, selectedGroupId: null });
    void loadTranscript(chatId);
  };

  /** The chats a group-wide prompt goes to: one per workspace, plus quick chats. */
  const groupChats = (groupId: string): Chat[] => {
    const { workspaces, chats, selectedChatIds } = get();
    const targets: Chat[] = [];
    for (const ws of workspaces) {
      if (ws.groupId !== groupId || ws.archived) continue;
      const own = chats.filter((c) => c.workspaceId === ws.id);
      const chat = own.find((c) => c.id === selectedChatIds[ws.id]) ?? own[own.length - 1];
      if (chat) targets.push(chat);
    }
    targets.push(...chats.filter((c) => c.groupId === groupId && !c.workspaceId));
    return targets;
  };

  return {
    repos: [],
    groups: [],
    workspaces: [],
    chats: [],
    statuses: {},
    selectedWorkspaceId: null,
    selectedQuickChatId: null,
    selectedGroupId: null,
    promotingChatId: null,
    forkingChatId: null,
    openingQuickChatIn: null,
    selectedChatIds: {},
    transcripts: {},
    partials: {},
    permissions: {},
    creatingWorkspaceIn: null,
    error: null,

    init: async () => {
      await listen<{ chatId: string; event: AgentEvent }>("agent-event", ({ payload }) =>
        onAgentEvent(payload.chatId, payload.event),
      );
      await listen<{ chatId: string; status: ChatStatus }>("chat-status", ({ payload }) =>
        set((s) => ({
          statuses: { ...s.statuses, [payload.chatId]: payload.status },
          permissions:
            payload.status === "idle" ? { ...s.permissions, [payload.chatId]: [] } : s.permissions,
          partials: payload.status === "idle" ? { ...s.partials, [payload.chatId]: "" } : s.partials,
        })),
      );
      await get().refresh();
      const first = get().workspaces.find((w) => !w.archived);
      if (first) select(first.id);
    },

    refresh: async () => {
      try {
        const { repos, workspaces, chats, groups, statuses } = await api.getState();
        set({ repos, workspaces, chats, groups, statuses });
      } catch (e) {
        fail(e);
      }
    },

    addRepo: async (path) => {
      try {
        await api.addRepo(path);
        await get().refresh();
      } catch (e) {
        fail(e);
      }
    },

    removeRepo: async (repoId) => {
      try {
        await api.removeRepo(repoId);
        await get().refresh();
      } catch (e) {
        fail(e);
      }
    },

    createWorkspace: async (repoId) => {
      set({ creatingWorkspaceIn: repoId });
      try {
        const { workspace, chat } = await api.createWorkspace(repoId);
        await prepareChat(chat);
        await get().refresh();
        select(workspace.id, chat.id);
      } catch (e) {
        fail(e);
      } finally {
        set({ creatingWorkspaceIn: null });
      }
    },

    archiveWorkspace: async (workspaceId) => {
      try {
        await api.archiveWorkspace(workspaceId);
        await get().refresh();
        if (get().selectedWorkspaceId === workspaceId) {
          const next = get().workspaces.find((w) => !w.archived);
          if (next) select(next.id);
          else set({ selectedWorkspaceId: null });
        }
      } catch (e) {
        fail(e);
      }
    },

    selectWorkspace: (workspaceId) => select(workspaceId),

    createChat: async (workspaceId) => {
      try {
        const chat = await api.createChat(workspaceId);
        await prepareChat(chat);
        await get().refresh();
        select(workspaceId, chat.id);
      } catch (e) {
        fail(e);
      }
    },

    selectChat: (chatId) => {
      const chat = get().chats.find((c) => c.id === chatId);
      if (chat?.workspaceId) select(chat.workspaceId, chatId);
      else if (chat) selectQuick(chatId);
    },

    openQuickChat: async (repoId) => {
      // Reuse a quick chat that was opened but never used.
      const unused = get().chats.find((c) => c.repoId === repoId && !c.title);
      if (unused) return selectQuick(unused.id);
      // The first quick chat in a bare repository has to check it out, which
      // can take a while; ignore further clicks until that is done.
      if (get().openingQuickChatIn) return;
      set({ openingQuickChatIn: repoId });
      try {
        const chat = await api.createQuickChat(repoId);
        await prepareChat(chat);
        await get().refresh();
        selectQuick(chat.id);
      } catch (e) {
        fail(e);
      } finally {
        set({ openingQuickChatIn: null });
      }
    },

    promoteChat: async (chatId) => {
      set({ promotingChatId: chatId });
      try {
        const { workspace } = await api.promoteChat(chatId);
        await get().refresh();
        select(workspace.id, chatId);
      } catch (e) {
        fail(e);
      } finally {
        set({ promotingChatId: null });
      }
    },

    deleteChat: async (chatId) => {
      try {
        await api.deleteChat(chatId);
        if (get().selectedQuickChatId === chatId) set({ selectedQuickChatId: null });
        await get().refresh();
      } catch (e) {
        fail(e);
      }
    },

    sendMessage: async (chatId, text) => {
      try {
        await api.sendMessage(chatId, text);
      } catch (e) {
        fail(e);
      }
    },

    setChatAgent: async (chatId, agent) => {
      try {
        await api.setChatAgent(chatId, agent);
        localStorage.setItem(PREFERRED_AGENT, agent);
        await get().refresh();
      } catch (e) {
        fail(e);
      }
    },

    forkChat: async (chatId, turn, withWorktree) => {
      if (get().forkingChatId) return;
      set({ forkingChatId: chatId });
      try {
        const { chat, workspace } = await api.forkChat(chatId, turn, withWorktree);
        await get().refresh();
        if (workspace) select(workspace.id, chat.id);
        else get().selectChat(chat.id);
      } catch (e) {
        fail(e);
      } finally {
        set({ forkingChatId: null });
      }
    },

    selectGroup: (groupId) =>
      set({ selectedGroupId: groupId, selectedWorkspaceId: null, selectedQuickChatId: null }),

    createGroup: async (name, first) => {
      try {
        const group = await api.createGroup(name);
        if (first) await api.setGroup(first, group.id);
        await get().refresh();
        if (!first) get().selectGroup(group.id);
      } catch (e) {
        fail(e);
      }
    },

    renameGroup: async (groupId, name) => {
      try {
        await api.renameGroup(groupId, name);
        await get().refresh();
      } catch (e) {
        fail(e);
      }
    },

    deleteGroup: async (groupId) => {
      try {
        await api.deleteGroup(groupId);
        if (get().selectedGroupId === groupId) set({ selectedGroupId: null });
        await get().refresh();
      } catch (e) {
        fail(e);
      }
    },

    setGroup: async (member, groupId) => {
      try {
        await api.setGroup(member, groupId);
        await get().refresh();
      } catch (e) {
        fail(e);
      }
    },

    archiveGroup: async (groupId) => {
      const members = get().workspaces.filter((w) => w.groupId === groupId && !w.archived);
      try {
        for (const ws of members) await api.archiveWorkspace(ws.id);
        await api.deleteGroup(groupId);
        if (get().selectedGroupId === groupId) set({ selectedGroupId: null });
      } catch (e) {
        fail(e);
      }
      await get().refresh();
    },

    broadcast: async (groupId, text) => {
      // A chat in the middle of a turn is left alone rather than interrupted.
      const targets = groupChats(groupId);
      const idle = targets.filter((c) => (get().statuses[c.id] ?? "idle") === "idle");
      await Promise.all(idle.map((c) => get().sendMessage(c.id, text)));
      return { sent: idle.length, skipped: targets.length - idle.length };
    },

    interrupt: async (chatId) => {
      try {
        await api.interrupt(chatId);
      } catch (e) {
        fail(e);
      }
    },

    respondPermission: async (chatId, requestId, allow) => {
      set((s) => ({
        permissions: {
          ...s.permissions,
          [chatId]: (s.permissions[chatId] ?? []).filter((p) => p.requestId !== requestId),
        },
      }));
      try {
        await api.respondPermission(chatId, requestId, allow);
      } catch (e) {
        fail(e);
      }
    },

    dismissError: () => set({ error: null }),
    reportError: fail,
  };
});

/** The most attention-worthy status among a group's workspaces and quick chats. */
export function groupStatus(
  groupId: string,
  workspaces: Workspace[],
  chats: Chat[],
  statuses: Record<string, ChatStatus>,
): ChatStatus {
  const workspaceIds = new Set(
    workspaces.filter((w) => w.groupId === groupId && !w.archived).map((w) => w.id),
  );
  let result: ChatStatus = "idle";
  for (const chat of chats) {
    const member = chat.workspaceId ? workspaceIds.has(chat.workspaceId) : chat.groupId === groupId;
    if (!member) continue;
    const status = statuses[chat.id] ?? "idle";
    if (status === "awaiting_permission") return status;
    if (status === "running") result = status;
  }
  return result;
}

/** The most attention-worthy status among a workspace's chats. */
export function workspaceStatus(
  workspaceId: string,
  chats: Chat[],
  statuses: Record<string, ChatStatus>,
): ChatStatus {
  let result: ChatStatus = "idle";
  for (const chat of chats) {
    if (chat.workspaceId !== workspaceId) continue;
    const status = statuses[chat.id] ?? "idle";
    if (status === "awaiting_permission") return status;
    if (status === "running") result = status;
  }
  return result;
}
