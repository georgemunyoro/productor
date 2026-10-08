import { useEffect } from "react";
import { ChatView } from "./components/ChatView";
import { GroupView } from "./components/GroupView";
import { RightPanel } from "./components/RightPanel";
import { Sidebar } from "./components/Sidebar";
import { usePanel } from "./panelStore";
import { useStore } from "./store";
import { listenToTerminals } from "./terminals";

let started = false;

export default function App() {
  const error = useStore((s) => s.error);
  const dismissError = useStore((s) => s.dismissError);
  const groupSelected = useStore((s) => s.selectedGroupId !== null);
  const sidebarOpen = usePanel((s) => s.sidebarOpen);

  useEffect(() => {
    // StrictMode mounts twice in development; register listeners only once.
    if (started) return;
    started = true;
    void useStore.getState().init();
    void listenToTerminals();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && !e.shiftKey && !e.altKey && e.key === "b") {
        e.preventDefault();
        usePanel.getState().toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={"app" + (sidebarOpen ? "" : " sidebar-hidden")}>
      {sidebarOpen && <Sidebar />}
      <main className="main">
        {groupSelected ? <GroupView /> : <ChatView />}
        <RightPanel />
      </main>
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
