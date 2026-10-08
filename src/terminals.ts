import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { api } from "./api";

export interface TerminalTab {
  id: string;
  workspaceId: string;
  title: string;
  exited: boolean;
}

interface TerminalStore {
  tabs: TerminalTab[];
  /** Tab shown in each workspace. */
  active: Record<string, string>;
  open: (workspaceId: string, command?: string) => Promise<void>;
  close: (id: string) => void;
  select: (workspaceId: string, id: string) => void;
}

// xterm instances live outside React so their scrollback survives switching
// workspaces and hiding the panel.
const instances = new Map<string, { term: Terminal; fit: FitAddon }>();

export function terminalInstance(id: string) {
  return instances.get(id);
}

function theme() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    background: v("--bg"),
    foreground: v("--text"),
    cursor: v("--text"),
    selectionBackground: v("--bg-selected"),
  };
}

export const useTerminals = create<TerminalStore>((set, get) => ({
  tabs: [],
  active: {},

  open: async (workspaceId, command) => {
    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 12,
      cursorBlink: true,
      scrollback: 10000,
      theme: theme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const id = await api.termOpen(workspaceId, term.cols, term.rows, command);
    instances.set(id, { term, fit });
    term.onData((data) => void api.termWrite(id, data).catch(() => {}));
    term.onResize(({ cols, rows }) => void api.termResize(id, cols, rows).catch(() => {}));

    const count = get().tabs.filter((t) => t.workspaceId === workspaceId && !command).length;
    const title = command ? "run" : `zsh ${count + 1}`;
    set((s) => ({
      tabs: [...s.tabs, { id, workspaceId, title, exited: false }],
      active: { ...s.active, [workspaceId]: id },
    }));
  },

  close: (id) => {
    void api.termClose(id);
    instances.get(id)?.term.dispose();
    instances.delete(id);
    set((s) => {
      const closing = s.tabs.find((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      const active = { ...s.active };
      if (closing && active[closing.workspaceId] === id) {
        const next = tabs.filter((t) => t.workspaceId === closing.workspaceId).pop();
        if (next) active[closing.workspaceId] = next.id;
        else delete active[closing.workspaceId];
      }
      return { tabs, active };
    });
  },

  select: (workspaceId, id) => set((s) => ({ active: { ...s.active, [workspaceId]: id } })),
}));

function decode(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function listenToTerminals() {
  await listen<{ id: string; data: string }>("term-output", ({ payload }) => {
    instances.get(payload.id)?.term.write(decode(payload.data));
  });
  await listen<{ id: string }>("term-exit", ({ payload }) => {
    instances.get(payload.id)?.term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n");
    useTerminals.setState((s) => ({
      tabs: s.tabs.map((t) => (t.id === payload.id ? { ...t, exited: true } : t)),
    }));
  });
}
