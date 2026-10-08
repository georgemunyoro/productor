import { useEffect, useRef, useState } from "react";
import { useUi } from "../ui";

declare global {
  interface Window {
    /** Non-standard but long supported by WebKit: selects and scrolls to the next match. */
    find?: (
      text: string,
      caseSensitive?: boolean,
      backwards?: boolean,
      wrap?: boolean,
    ) => boolean;
  }
}

/** Find-in-chat: steps through matches in the transcript on screen. */
export function FindBar() {
  const open = useUi((s) => s.findOpen);
  const [query, setQuery] = useState("");
  const [missing, setMissing] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) input.current?.select();
  }, [open]);

  if (!open) return null;

  const close = () => {
    useUi.getState().setFindOpen(false);
    window.getSelection()?.removeAllRanges();
  };

  const find = (backwards: boolean) => {
    if (!query) return;
    const found = window.find?.(query, false, backwards, true) ?? false;
    setMissing(!found);
    // Searching moves focus to the match; bring it back so Enter keeps stepping.
    input.current?.focus();
  };

  return (
    <div className="find-bar" role="search">
      <input
        ref={input}
        autoFocus
        aria-label="Find in this chat"
        placeholder="Find in this chat…"
        value={query}
        className={missing ? "missing" : ""}
        onChange={(e) => {
          setQuery(e.target.value);
          setMissing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") find(e.shiftKey);
          if (e.key === "Escape") close();
        }}
      />
      {missing && <span className="find-status">No matches</span>}
      <button className="icon-button" title="Previous match (Shift+Enter)" onClick={() => find(true)}>
        ↑
      </button>
      <button className="icon-button" title="Next match (Enter)" onClick={() => find(false)}>
        ↓
      </button>
      <button className="icon-button" title="Close (Esc)" onClick={close}>
        ×
      </button>
    </div>
  );
}
