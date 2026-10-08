import { usePanel } from "../panelStore";

/** Switches the inbox between review requests and the user's own pull requests. */
export function InboxTabs() {
  const tab = usePanel((s) => s.inboxTab);
  const { setInboxTab } = usePanel.getState();
  return (
    <nav className="tabs" aria-label="Inbox">
      <button className={"tab" + (tab === "reviews" ? " selected" : "")} onClick={() => setInboxTab("reviews")}>
        Review requests
      </button>
      <button className={"tab" + (tab === "mine" ? " selected" : "")} onClick={() => setInboxTab("mine")}>
        My pull requests
      </button>
    </nav>
  );
}
