import { create } from "zustand";
import type { Attachment, SlashCommand } from "./types";

export type Theme = "system" | "light" | "dark";

export interface QueuedMessage {
  text: string;
  attachments: Attachment[];
}

interface UiStore {
  /** What has been typed but not sent, per chat. */
  drafts: Record<string, string>;
  /** Files attached to the draft, per chat. */
  attachments: Record<string, Attachment[]>;
  /** Messages waiting for the agent to finish its current turn, per chat. */
  queues: Record<string, QueuedMessage[]>;
  /** Chats that finished or asked for something while not on screen. */
  unread: Record<string, true>;
  /** Slash commands the agent last reported. */
  commands: SlashCommand[];
  theme: Theme;
  paletteOpen: boolean;
  findOpen: boolean;

  setDraft: (chatId: string, text: string) => void;
  setAttachments: (chatId: string, attachments: Attachment[]) => void;
  enqueue: (chatId: string, message: QueuedMessage) => void;
  /** Removes and returns the next queued message for a chat. */
  dequeue: (chatId: string) => QueuedMessage | undefined;
  unqueue: (chatId: string, index: number) => void;
  markUnread: (chatId: string) => void;
  markRead: (chatId: string) => void;
  setCommands: (commands: SlashCommand[]) => void;
  setTheme: (theme: Theme) => void;
  setPaletteOpen: (open: boolean) => void;
  setFindOpen: (open: boolean) => void;
}

function saved<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // These are conveniences; the app works without them being remembered.
  }
}

/** Applies the theme to the document; "system" follows the OS setting. */
function applyTheme(theme: Theme) {
  // There is no document when the stores are loaded by the unit tests.
  if (typeof document === "undefined") return;
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export const useUi = create<UiStore>((set, get) => {
  const theme = saved<Theme>("theme", "system");
  applyTheme(theme);
  return {
    drafts: saved("drafts", {}),
    attachments: {},
    queues: {},
    unread: saved("unread", {}),
    commands: [],
    theme,
    paletteOpen: false,
    findOpen: false,

    setDraft: (chatId, text) => {
      const drafts = { ...get().drafts };
      if (text) drafts[chatId] = text;
      else delete drafts[chatId];
      save("drafts", drafts);
      set({ drafts });
    },

    setAttachments: (chatId, attachments) =>
      set((s) => ({ attachments: { ...s.attachments, [chatId]: attachments } })),

    enqueue: (chatId, message) =>
      set((s) => ({ queues: { ...s.queues, [chatId]: [...(s.queues[chatId] ?? []), message] } })),

    dequeue: (chatId) => {
      const [next, ...rest] = get().queues[chatId] ?? [];
      if (next) set((s) => ({ queues: { ...s.queues, [chatId]: rest } }));
      return next;
    },

    unqueue: (chatId, index) =>
      set((s) => ({
        queues: { ...s.queues, [chatId]: (s.queues[chatId] ?? []).filter((_, i) => i !== index) },
      })),

    markUnread: (chatId) => {
      if (get().unread[chatId]) return;
      const unread = { ...get().unread, [chatId]: true as const };
      save("unread", unread);
      set({ unread });
    },

    markRead: (chatId) => {
      if (!get().unread[chatId]) return;
      const unread = { ...get().unread };
      delete unread[chatId];
      save("unread", unread);
      set({ unread });
    },

    setCommands: (commands) => set({ commands }),

    setTheme: (theme) => {
      save("theme", theme);
      applyTheme(theme);
      set({ theme });
    },

    setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
    setFindOpen: (findOpen) => set({ findOpen }),
  };
});
