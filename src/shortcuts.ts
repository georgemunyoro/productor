import { usePanel } from "./panelStore";
import { useStore } from "./store";
import { useUi } from "./ui";

/** Moves to the chat before or after the current one in its workspace. */
function stepChat(step: number) {
  const s = useStore.getState();
  const workspaceId = s.selectedWorkspaceId;
  if (!workspaceId) return;
  const tabs = s.chats.filter((c) => c.workspaceId === workspaceId);
  const at = tabs.findIndex((c) => c.id === s.selectedChatIds[workspaceId]);
  const next = tabs[(at + step + tabs.length) % tabs.length];
  if (next) s.selectChat(next.id);
}

/** The repository new things are created in: the one being looked at. */
function currentRepo(): string | undefined {
  const s = useStore.getState();
  const workspace = s.workspaces.find((w) => w.id === s.selectedWorkspaceId);
  const quick = s.chats.find((c) => c.id === s.selectedQuickChatId);
  return workspace?.repoId ?? quick?.repoId ?? s.repos[0]?.id;
}

/** Handles the app-wide ⌘ shortcuts. Returns whether the key was one. */
export function handleShortcut(e: KeyboardEvent): boolean {
  if (!e.metaKey || e.altKey || e.ctrlKey) return false;
  const store = useStore.getState();
  const ui = useUi.getState();

  if (e.shiftKey) {
    // The bracket keys report as braces when Shift is held.
    if (e.key === "]" || e.key === "}") stepChat(1);
    else if (e.key === "[" || e.key === "{") stepChat(-1);
    else return false;
    return true;
  }

  switch (e.key) {
    case "k":
      ui.setPaletteOpen(!ui.paletteOpen);
      return true;
    case "b":
      usePanel.getState().toggleSidebar();
      return true;
    case "j":
      if (store.selectedWorkspaceId) usePanel.getState().toggle();
      return true;
    case "f":
      ui.setFindOpen(true);
      return true;
    case ",":
      store.selectView("settings");
      return true;
    case "l":
      document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
      return true;
    case "t":
      if (store.selectedWorkspaceId) void store.createChat(store.selectedWorkspaceId);
      return true;
    case "n": {
      const repo = currentRepo();
      if (repo && !store.creatingWorkspaceIn) void store.createWorkspace(repo);
      return true;
    }
  }
  if (/^[1-9]$/.test(e.key)) {
    // In sidebar order: grouped workspaces first, then each repository's.
    const active = store.workspaces.filter((w) => !w.archived);
    const ordered = [
      ...store.groups.flatMap((g) => active.filter((w) => w.groupId === g.id)),
      ...store.repos.flatMap((r) => active.filter((w) => w.repoId === r.id && !w.groupId)),
    ];
    const target = ordered[Number(e.key) - 1];
    if (target) store.selectWorkspace(target.id);
    return true;
  }
  return false;
}
