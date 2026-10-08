import { usePanel } from "../panelStore";

/**
 * Shows or hides the sidebar. One copy lives in the sidebar and another in
 * each main header; `whenSidebar` says in which state this copy is visible.
 */
export function SidebarToggle({ whenSidebar }: { whenSidebar: "shown" | "hidden" }) {
  const open = usePanel((s) => s.sidebarOpen);
  if (open !== (whenSidebar === "shown")) return null;
  return (
    <button
      className="icon-button sidebar-toggle"
      title={open ? "Hide sidebar (⌘B)" : "Show sidebar (⌘B)"}
      aria-label={open ? "Hide sidebar" : "Show sidebar"}
      onClick={usePanel.getState().toggleSidebar}
    >
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
        <rect x="1.7" y="2.7" width="12.6" height="10.6" rx="2" stroke="currentColor" strokeWidth="1.3" />
        <path d="M6 3v10" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    </button>
  );
}
