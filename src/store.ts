import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { create } from "zustand";
import { api, type Member } from "./api";
import { useTerminals } from "./terminals";
import { useUi } from "./ui";
import type {
  AgentDefaults,
  AgentEvent,
  AgentKind,
  Chat,
  ChatStatus,
  Group,
  InboxItem,
  PermissionRequest,
  PrAction,
  PrStatus,
  Settings,
  SlashCommand,
  Repo,
  Workspace,
} from "./types";

interface AppStore {
  repos: Repo[];
  workspaces: Workspace[];
  chats: Chat[];
  groups: Group[];
  inbox: InboxItem[];
  prs: Record<string, PrStatus>;
  agentDefaults: AgentDefaults;
  settings: Settings;
  /** Background work that is currently failing, by what it is. */
  problems: Record<string, string>;
  claudeFastRefused: string | null;
  statuses: Record<string, ChatStatus>;
  /** Set while the inbox is shown. */
  selectedView: "inbox" | "settings" | null;
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
  renameChat: (chatId: string, title: string) => Promise<void>;
  renameWorkspace: (workspaceId: string, name: string) => Promise<void>;
  setChatAgent: (chatId: string, agent: AgentKind) => Promise<void>;
  setChatOptions: (chat: Chat, model: string | null, fast: boolean | null) => Promise<void>;
  /** Forks a chat after a turn; `draft` is left ready in the fork's composer. */
  forkChat: (chatId: string, turn: number, withWorktree: boolean, draft?: string) => Promise<void>;
  selectGroup: (groupId: string) => void;
  createGroup: (name: string, first?: Member) => Promise<void>;
  renameGroup: (groupId: string, name: string) => Promise<void>;
  deleteGroup: (groupId: string) => Promise<void>;
  setGroup: (member: Member, groupId: string | null) => Promise<void>;
  archiveGroup: (groupId: string) => Promise<void>;
  broadcast: (groupId: string, text: string) => Promise<{ sent: number; skipped: number }>;
  selectView: (view: "inbox" | "settings") => void;
  /** Opens an item's review, starting one if there is none yet. */
  reviewInboxItem: (item: InboxItem) => Promise<void>;
  markInboxRead: (itemId: string | null) => Promise<void>;
  deleteInboxItem: (itemId: string) => Promise<void>;
  refreshInbox: () => Promise<void>;
  refreshPr: (workspaceId: string) => Promise<void>;
  prAction: (workspaceId: string, chatId: string | null, action: PrAction) => Promise<void>;
  setAutoPr: (workspaceId: string, enabled: boolean) => Promise<void>;
  setAutoPush: (workspaceId: string, enabled: boolean) => Promise<void>;
  /** Opens one of the user's pull requests as a workspace on its branch. */
  openPrWorkspace: (repo: string, number: number) => Promise<void>;
  openingPr: string | null;
  reviewingItemId: string | null;
  sendMessage: (chatId: string, text: string, attachments?: string[]) => Promise<void>;
  /** Deletes a chat, with its conversation. */
  closeChat: (chatId: string) => Promise<void>;
  setChatPlan: (chatId: string, plan: boolean) => Promise<void>;
  answerQuestion: (chatId: string, requestId: string, answers: Record<string, string>) => Promise<void>;
  restoreWorkspace: (workspaceId: string) => Promise<void>;
  setSettings: (settings: Settings) => Promise<void>;
  /** Starts a chat in the same place as another, with a draft ready in it. */
  newChatLike: (chatId: string, draft: string) => Promise<void>;
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

interface ModelChoice {
  model: string | null;
  fast: boolean | null;
}

/** The model and speed last chosen for an agent, which new chats start with. */
function preferredModel(agent: AgentKind): ModelChoice {
  try {
    return { model: null, fast: null, ...JSON.parse(localStorage.getItem(`agent.model.${agent}`) ?? "{}") };
  } catch {
    return { model: null, fast: null };
  }
}

/** Gives a newly created chat the preferred agent, model and speed, and gets it ready. */
async function prepareChat(chat: Chat) {
  const agent = preferredAgent();
  if (agent !== chat.agent) await api.setChatAgent(chat.id, agent);
  const preferred = preferredModel(agent);
  const model = preferred.model;
  // Asking for fast mode again after it was refused would only repeat the refusal.
  const refused = agent === "claude" && useStore.getState().claudeFastRefused !== null;
  const fast = refused ? null : preferred.fast;
  // Setting the options also starts the agent with them, where that helps.
  if (model !== null || fast !== null) await api.setChatOptions(chat.id, model, fast);
  else if (agent === chat.agent) await api.warmUpChat(chat.id);
}

const NOTIFY_TITLES: Record<InboxItem["status"], string> = {
  new: "Review requested",
  running: "Review started",
  needs_approval: "A review needs your approval",
  done: "Review ready",
  failed: "Review failed",
};

async function raise(title: string, body: string) {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch {
    // The inbox still shows the item if notifications are unavailable.
  }
}

/** Raises a system notification for an inbox item that wants attention. */
const notify = (item: InboxItem) =>
  raise(NOTIFY_TITLES[item.status], `${item.repo} #${item.number}: ${item.title}`);

const notifyMany = (count: number) =>
  raise("Review requests", `${count} more pull requests are waiting for your review.`);

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
      selectedView: null,
      selectedChatIds: chat ? { ...s.selectedChatIds, [workspaceId]: chat } : s.selectedChatIds,
    }));
    if (chat) {
      useUi.getState().markRead(chat);
      void loadTranscript(chat);
    }
  };

  /**
   * Runs the repository's setup script in a new workspace, in a terminal
   * tab so its output can be watched and it can be interrupted.
   */
  const runSetup = (workspaceId: string) => {
    const workspace = get().workspaces.find((w) => w.id === workspaceId);
    const script = get().repos.find((r) => r.id === workspace?.repoId)?.setupScript;
    if (script) void useTerminals.getState().open(workspaceId, script, "setup").catch(fail);
  };

  /** Whether a chat is the one on screen, in a window that has focus. */
  const watching = (chatId: string) => {
    const s = get();
    const onScreen =
      s.selectedQuickChatId === chatId ||
      (s.selectedWorkspaceId !== null && s.selectedChatIds[s.selectedWorkspaceId] === chatId);
    return onScreen && s.selectedView === null && s.selectedGroupId === null && document.hasFocus();
  };

  /** A chat's name for a notification: its workspace and title. */
  const chatName = (chatId: string) => {
    const chat = get().chats.find((c) => c.id === chatId);
    const workspace = get().workspaces.find((w) => w.id === chat?.workspaceId);
    return [workspace?.name, chat?.title].filter(Boolean).join(" · ") || "Chat";
  };

  const onStatus = (chatId: string, status: ChatStatus, previous: ChatStatus) => {
    const ui = useUi.getState();
    const chat = get().chats.find((c) => c.id === chatId);
    if (status === "idle") {
      // Anything typed while the agent was busy goes out now.
      const next = ui.dequeue(chatId);
      if (next) {
        void get().sendMessage(chatId, next.text, next.attachments.map((a) => a.path));
        return;
      }
    }
    // Inbox reviews announce themselves through the inbox.
    if (watching(chatId) || chat?.inboxId) return;
    if (status === "idle" && previous !== "idle") {
      ui.markUnread(chatId);
      void raise(`${chat?.agent === "codex" ? "Codex" : "Claude"} finished`, chatName(chatId));
    } else if (status === "awaiting_permission" && previous !== "awaiting_permission") {
      ui.markUnread(chatId);
      void raise("Waiting for you", chatName(chatId));
    }
  };

  const selectQuick = (chatId: string) => {
    useUi.getState().markRead(chatId);
    set({
      selectedQuickChatId: chatId,
      selectedWorkspaceId: null,
      selectedGroupId: null,
      selectedView: null,
    });
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
    inbox: [],
    prs: {},
    agentDefaults: { claudeModel: null, codexModel: null, codexFast: false },
    settings: { useApiKey: false, editor: "code" },
    problems: {},
    claudeFastRefused: null,
    selectedView: null,
    reviewingItemId: null,
    openingPr: null,
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
      await listen<{ chatId: string; status: ChatStatus }>("chat-status", ({ payload }) => {
        const previous = get().statuses[payload.chatId] ?? "idle";
        set((s) => ({
          statuses: { ...s.statuses, [payload.chatId]: payload.status },
          permissions:
            payload.status === "idle" ? { ...s.permissions, [payload.chatId]: [] } : s.permissions,
          partials: payload.status === "idle" ? { ...s.partials, [payload.chatId]: "" } : s.partials,
        }));
        onStatus(payload.chatId, payload.status, previous);
      });
      await listen<{ commands: SlashCommand[] }>("agent-commands", ({ payload }) =>
        useUi.getState().setCommands(payload.commands),
      );
      await listen<{ notify: InboxItem[] }>("inbox-changed", ({ payload }) => {
        void get().refresh();
        // A burst, such as being added to a team, is one notification.
        if (payload.notify.length > 3) void notifyMany(payload.notify.length);
        else for (const item of payload.notify) void notify(item);
      });
      await listen<{ notify: { title: string; body: string }[] }>("pr-changed", ({ payload }) => {
        void get().refresh();
        for (const { title, body } of payload.notify) void raise(title, body);
      });
      await get().refresh();
      api.agentDefaults().then((agentDefaults) => set({ agentDefaults }), () => {});
      const first = get().workspaces.find((w) => !w.archived);
      if (first) select(first.id);
    },

    refresh: async () => {
      try {
        const snapshot = await api.getState();
        set({ ...snapshot });
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
        runSetup(workspace.id);
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
        runSetup(workspace.id);
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

    sendMessage: async (chatId, text, attachments = []) => {
      try {
        await api.sendMessage(chatId, text, attachments);
      } catch (e) {
        fail(e);
      }
    },

    closeChat: async (chatId) => {
      const chat = get().chats.find((c) => c.id === chatId);
      try {
        await api.deleteChat(chatId);
        useUi.getState().setDraft(chatId, "");
        useUi.getState().markRead(chatId);
        await get().refresh();
        // Fall back to another chat in the same workspace, if there is one.
        const workspaceId = chat?.workspaceId;
        if (workspaceId && get().selectedChatIds[workspaceId] === chatId) {
          const next = get().chats.filter((c) => c.workspaceId === workspaceId).pop();
          set((s) => {
            const selectedChatIds = { ...s.selectedChatIds };
            if (next) selectedChatIds[workspaceId] = next.id;
            else delete selectedChatIds[workspaceId];
            return { selectedChatIds };
          });
          if (next) void loadTranscript(next.id);
        }
        if (get().selectedQuickChatId === chatId) set({ selectedQuickChatId: null });
      } catch (e) {
        fail(e);
      }
    },

    setChatPlan: async (chatId, plan) => {
      try {
        await api.setChatPlan(chatId, plan);
        await get().refresh();
      } catch (e) {
        fail(e);
      }
    },

    answerQuestion: async (chatId, requestId, answers) => {
      set((s) => ({
        permissions: {
          ...s.permissions,
          [chatId]: (s.permissions[chatId] ?? []).filter((p) => p.requestId !== requestId),
        },
      }));
      try {
        await api.answerQuestion(chatId, requestId, answers);
      } catch (e) {
        fail(e);
      }
    },

    restoreWorkspace: async (workspaceId) => {
      try {
        await api.restoreWorkspace(workspaceId);
        await get().refresh();
        select(workspaceId);
      } catch (e) {
        fail(e);
      }
    },

    setSettings: async (settings) => {
      try {
        await api.setSettings(settings);
        await get().refresh();
      } catch (e) {
        fail(e);
      }
    },

    newChatLike: async (chatId, draft) => {
      const source = get().chats.find((c) => c.id === chatId);
      if (!source) return;
      try {
        const chat = source.workspaceId
          ? await api.createChat(source.workspaceId)
          : await api.createQuickChat(source.repoId ?? "");
        await prepareChat(chat);
        useUi.getState().setDraft(chat.id, draft);
        await get().refresh();
        get().selectChat(chat.id);
      } catch (e) {
        fail(e);
      }
    },

    renameChat: async (chatId, title) => {
      try {
        await api.renameChat(chatId, title);
        await get().refresh();
      } catch (e) {
        fail(e);
      }
    },

    renameWorkspace: async (workspaceId, name) => {
      try {
        await api.renameWorkspace(workspaceId, name);
        await get().refresh();
      } catch (e) {
        fail(e);
      }
    },

    setChatOptions: async (chat, model, fast) => {
      try {
        await api.setChatOptions(chat.id, model, fast);
        localStorage.setItem(`agent.model.${chat.agent}`, JSON.stringify({ model, fast }));
        await get().refresh();
      } catch (e) {
        fail(e);
      }
    },

    setChatAgent: async (chatId, agent) => {
      try {
        await api.setChatAgent(chatId, agent);
        // The other agent's models mean nothing to this one.
        const { model, fast } = preferredModel(agent);
        await api.setChatOptions(chatId, model, fast);
        localStorage.setItem(PREFERRED_AGENT, agent);
        await get().refresh();
      } catch (e) {
        fail(e);
      }
    },

    forkChat: async (chatId, turn, withWorktree, draft) => {
      if (get().forkingChatId) return;
      set({ forkingChatId: chatId });
      try {
        const { chat, workspace } = await api.forkChat(chatId, turn, withWorktree);
        if (draft) useUi.getState().setDraft(chat.id, draft);
        await get().refresh();
        if (workspace) {
          select(workspace.id, chat.id);
          runSetup(workspace.id);
        }
        else get().selectChat(chat.id);
      } catch (e) {
        fail(e);
      } finally {
        set({ forkingChatId: null });
      }
    },

    selectGroup: (groupId) =>
      set({
        selectedGroupId: groupId,
        selectedWorkspaceId: null,
        selectedQuickChatId: null,
        selectedView: null,
      }),

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

    selectView: (view) =>
      set({
        selectedView: view,
        selectedWorkspaceId: null,
        selectedQuickChatId: null,
        selectedGroupId: null,
      }),

    refreshPr: async (workspaceId) => {
      try {
        await api.refreshPr(workspaceId);
        await get().refresh();
      } catch (e) {
        fail(e);
      }
    },

    prAction: async (workspaceId, chatId, action) => {
      try {
        await api.prAction(workspaceId, chatId, action);
      } catch (e) {
        fail(e);
      }
    },

    setAutoPr: async (workspaceId, enabled) => {
      try {
        await api.setAutoPr(workspaceId, enabled);
      } catch (e) {
        fail(e);
      }
      await get().refresh();
    },

    setAutoPush: async (workspaceId, enabled) => {
      try {
        await api.setAutoPush(workspaceId, enabled);
      } catch (e) {
        fail(e);
      }
      await get().refresh();
    },

    openPrWorkspace: async (repo, number) => {
      if (get().openingPr) return;
      set({ openingPr: `${repo}#${number}` });
      try {
        const { workspace, chat } = await api.openPrWorkspace(repo, number);
        // No chat comes back when the pull request was already open here.
        if (chat) await prepareChat(chat);
        await get().refresh();
        select(workspace.id, chat?.id);
        if (chat) runSetup(workspace.id);
        void api.refreshPr(workspace.id).then(get().refresh, () => {});
      } catch (e) {
        fail(e);
      } finally {
        set({ openingPr: null });
      }
    },

    reviewInboxItem: async (item) => {
      if (get().reviewingItemId) return;
      if (!item.read) void get().markInboxRead(item.id);
      // Starting a review can take a while the first time, when a bare
      // repository's shared checkout has to be created.
      set({ reviewingItemId: item.id });
      try {
        const chatId = item.chatId ?? (await api.startReview(item.id));
        await get().refresh();
        // A review that was promoted now lives in a workspace.
        const workspaceId = get().chats.find((c) => c.id === chatId)?.workspaceId;
        if (workspaceId) select(workspaceId, chatId);
        else selectQuick(chatId);
      } catch (e) {
        fail(e);
      } finally {
        set({ reviewingItemId: null });
      }
    },

    markInboxRead: async (itemId) => {
      try {
        await api.markInboxRead(itemId);
        await get().refresh();
      } catch (e) {
        fail(e);
      }
    },

    deleteInboxItem: async (itemId) => {
      try {
        await api.deleteInboxItem(itemId);
        await get().refresh();
      } catch (e) {
        fail(e);
      }
    },

    refreshInbox: async () => {
      try {
        await api.refreshInbox();
        await get().refresh();
      } catch (e) {
        fail(e);
      }
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
