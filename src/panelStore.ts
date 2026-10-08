import { create } from "zustand";
import { api } from "./api";
import { parseDiff, type DiffFile } from "./diff";
import { useStore } from "./store";

export type PanelTab = "changes" | "files" | "terminal";

export interface ReviewComment {
  id: string;
  path: string;
  /** Line number in the new file, or in the old file for a deleted line. */
  line: number;
  side: "new" | "old";
  lineText: string;
  text: string;
}

interface DiffState {
  files: DiffFile[];
  /** Paths with changes that are not committed yet. */
  uncommitted: string[];
  /** Commits not pushed yet; null if the branch has never been pushed. */
  unpushed: number | null;
  loading: boolean;
  error: string | null;
}

interface PanelStore {
  open: boolean;
  tab: PanelTab;
  width: number;
  sidebarOpen: boolean;
  sidebarWidth: number;
  /** Sidebar sections the user has collapsed, by key. */
  collapsed: Record<string, boolean>;
  inboxTab: "reviews" | "mine";
  diffs: Record<string, DiffState>;
  comments: Record<string, ReviewComment[]>;

  toggle: () => void;
  setTab: (tab: PanelTab) => void;
  setWidth: (width: number) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  toggleSection: (key: string) => void;
  setInboxTab: (tab: "reviews" | "mine") => void;
  loadDiff: (workspaceId: string) => Promise<void>;
  addComment: (workspaceId: string, comment: Omit<ReviewComment, "id">) => void;
  removeComment: (workspaceId: string, id: string) => void;
  sendReview: (workspaceId: string, chatId: string) => Promise<void>;
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
    // Layout preferences are a convenience; losing them is harmless.
  }
}

/** Formats review comments as a message the agent can act on. */
export function reviewMessage(comments: ReviewComment[]): string {
  const sorted = [...comments].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  const parts = sorted.map((c) => {
    const where = c.side === "old" ? `${c.path}:${c.line} (removed line)` : `${c.path}:${c.line}`;
    return `${where}\n> ${c.lineText.trim() || "(blank line)"}\n${c.text}`;
  });
  return `I reviewed your changes. Please address these comments:\n\n${parts.join("\n\n")}`;
}

export const usePanel = create<PanelStore>((set, get) => ({
  open: saved("panel.open", true),
  tab: saved<PanelTab>("panel.tab", "changes"),
  width: saved("panel.width", 520),
  sidebarOpen: saved("sidebar.open", true),
  sidebarWidth: saved("sidebar.width", 250),
  collapsed: saved<Record<string, boolean>>("sidebar.collapsed", {}),
  inboxTab: saved<"reviews" | "mine">("inbox.tab", "reviews"),
  diffs: {},
  comments: {},

  toggle: () => {
    save("panel.open", !get().open);
    set({ open: !get().open });
  },
  setTab: (tab) => {
    save("panel.tab", tab);
    set({ tab });
  },
  setWidth: (width) => {
    save("panel.width", width);
    set({ width });
  },

  toggleSidebar: () => {
    save("sidebar.open", !get().sidebarOpen);
    set({ sidebarOpen: !get().sidebarOpen });
  },
  setSidebarWidth: (sidebarWidth) => {
    save("sidebar.width", sidebarWidth);
    set({ sidebarWidth });
  },

  setInboxTab: (inboxTab) => {
    save("inbox.tab", inboxTab);
    set({ inboxTab });
  },

  toggleSection: (key) => {
    const collapsed = { ...get().collapsed };
    if (collapsed[key]) delete collapsed[key];
    else collapsed[key] = true;
    save("sidebar.collapsed", collapsed);
    set({ collapsed });
  },

  loadDiff: async (workspaceId) => {
    const previous = get().diffs[workspaceId];
    if (previous?.loading) return;
    set((s) => ({
      diffs: {
        ...s.diffs,
        [workspaceId]: {
          files: previous?.files ?? [],
          uncommitted: previous?.uncommitted ?? [],
          unpushed: previous?.unpushed ?? null,
          loading: true,
          error: null,
        },
      },
    }));
    try {
      const { diff, uncommitted, unpushed } = await api.getDiff(workspaceId);
      set((s) => ({
        diffs: {
          ...s.diffs,
          [workspaceId]: { files: parseDiff(diff), uncommitted, unpushed, loading: false, error: null },
        },
      }));
    } catch (e) {
      set((s) => ({
        diffs: {
          ...s.diffs,
          [workspaceId]: {
            files: previous?.files ?? [],
            uncommitted: previous?.uncommitted ?? [],
            unpushed: previous?.unpushed ?? null,
            loading: false,
            error: String(e),
          },
        },
      }));
    }
  },

  addComment: (workspaceId, comment) =>
    set((s) => ({
      comments: {
        ...s.comments,
        [workspaceId]: [...(s.comments[workspaceId] ?? []), { ...comment, id: crypto.randomUUID() }],
      },
    })),

  removeComment: (workspaceId, id) =>
    set((s) => ({
      comments: {
        ...s.comments,
        [workspaceId]: (s.comments[workspaceId] ?? []).filter((c) => c.id !== id),
      },
    })),

  sendReview: async (workspaceId, chatId) => {
    const comments = get().comments[workspaceId] ?? [];
    if (comments.length === 0) return;
    await useStore.getState().sendMessage(chatId, reviewMessage(comments));
    set((s) => ({ comments: { ...s.comments, [workspaceId]: [] } }));
  },
}));
