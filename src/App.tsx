import { useEffect } from "react";
import { ChatView } from "./components/ChatView";
import { CommandPalette } from "./components/CommandPalette";
import { GroupView } from "./components/GroupView";
import { InboxView } from "./components/InboxView";
import { MyPullRequestsView } from "./components/MyPullRequestsView";
import { RightPanel } from "./components/RightPanel";
import { SettingsView } from "./components/SettingsView";
import { Sidebar } from "./components/Sidebar";
import { usePanel } from "./panelStore";
import { handleShortcut } from "./shortcuts";
import { useStore } from "./store";
import { listenToTerminals } from "./terminals";

let started = false;

export default function App() {
  const error = useStore((s) => s.error);
  const dismissError = useStore((s) => s.dismissError);
  const groupSelected = useStore((s) => s.selectedGroupId !== null);
  const view = useStore((s) => s.selectedView);
  const sidebarOpen = usePanel((s) => s.sidebarOpen);
  const inboxTab = usePanel((s) => s.inboxTab);

  useEffect(() => {
    // StrictMode mounts twice in development; register listeners only once.
    if (started) return;
    started = true;
    void useStore.getState().init();
    void listenToTerminals();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (handleShortcut(e)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={"app" + (sidebarOpen ? "" : " sidebar-hidden")}>
      {sidebarOpen && <Sidebar />}
      <main className="main">
        {view === "inbox" ? (
          inboxTab === "mine" ? (
            <MyPullRequestsView />
          ) : (
            <InboxView />
          )
        ) : view === "settings" ? (
          <SettingsView />
        ) : groupSelected ? (
          <GroupView />
        ) : (
          <ChatView />
        )}
        <RightPanel />
      </main>
      <CommandPalette />
      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button onClick={dismissError} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
    </div>
  );
}
