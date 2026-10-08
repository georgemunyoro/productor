import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { terminalInstance, useTerminals } from "../terminals";
import type { Workspace } from "../types";

// Guards the automatic first terminal against being opened twice while the
// first request is still in flight.
const opening = new Set<string>();

export function TerminalPanel({ workspace }: { workspace: Workspace }) {
  const allTabs = useTerminals((s) => s.tabs);
  const activeId = useTerminals((s) => s.active[workspace.id]);
  const repo = useStore((s) => s.repos.find((r) => r.id === workspace.repoId));
  const { refresh, reportError } = useStore.getState();
  const { open, close, select } = useTerminals.getState();
  const [editingScript, setEditingScript] = useState(false);
  const [script, setScript] = useState("");

  const tabs = allTabs.filter((t) => t.workspaceId === workspace.id);

  const openTerminal = (command?: string) => open(workspace.id, command).catch(reportError);

  useEffect(() => {
    const hasTabs = useTerminals.getState().tabs.some((t) => t.workspaceId === workspace.id);
    if (hasTabs || opening.has(workspace.id)) return;
    opening.add(workspace.id);
    void open(workspace.id)
      .catch(reportError)
      .finally(() => opening.delete(workspace.id));
  }, [workspace.id, open, reportError]);

  const run = () => {
    if (repo?.runScript) void openTerminal(repo.runScript);
    else editScript();
  };

  const editScript = () => {
    setScript(repo?.runScript ?? "");
    setEditingScript(true);
  };

  const saveScript = async () => {
    if (!repo) return;
    try {
      await api.setRunScript(repo.id, script.trim() || null);
      await refresh();
      setEditingScript(false);
    } catch (e) {
      reportError(e);
    }
  };

  return (
    <div className="panel-body">
      <div className="panel-toolbar">
        <nav className="tabs">
          {tabs.map((tab) => (
            <span key={tab.id} className={"tab closable" + (tab.id === activeId ? " selected" : "")}>
              <button onClick={() => select(workspace.id, tab.id)}>
                {tab.title}
                {tab.exited ? " (exited)" : ""}
              </button>
              <button className="tab-close" title="Close terminal" onClick={() => close(tab.id)}>
                ×
              </button>
            </span>
          ))}
          <button className="icon-button" title="New terminal" onClick={() => openTerminal()}>
            +
          </button>
        </nav>
        <span className="spacer" />
        <button
          className="button small"
          title={repo?.runScript ?? "Set a run script for this repository"}
          onClick={run}
        >
          Run
        </button>
        <button className="button small" title="Edit the run script" onClick={editScript}>
          Edit
        </button>
      </div>
      {editingScript && (
        <form
          className="script-form"
          onSubmit={(e) => {
            e.preventDefault();
            void saveScript();
          }}
        >
          <label htmlFor="run-script">Run script for {repo?.name}</label>
          <input
            id="run-script"
            autoFocus
            value={script}
            placeholder="pnpm install && pnpm dev"
            spellCheck={false}
            onChange={(e) => setScript(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setEditingScript(false)}
          />
          <button type="button" className="button small" onClick={() => setEditingScript(false)}>
            Cancel
          </button>
          <button type="submit" className="button primary small">
            Save
          </button>
        </form>
      )}
      {activeId && tabs.some((t) => t.id === activeId) ? (
        <TerminalView key={activeId} id={activeId} />
      ) : (
        <p className="panel-empty">No terminal open.</p>
      )}
    </div>
  );
}

function TerminalView({ id }: { id: string }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const instance = terminalInstance(id);
    const el = container.current;
    if (!instance || !el) return;
    const { term, fit } = instance;
    if (term.element) el.appendChild(term.element);
    else term.open(el);

    const fitNow = () => {
      if (el.offsetWidth > 0 && el.offsetHeight > 0) fit.fit();
    };
    fitNow();
    term.focus();
    const observer = new ResizeObserver(fitNow);
    observer.observe(el);
    return () => {
      observer.disconnect();
      term.element?.remove();
    };
  }, [id]);

  return <div className="terminal-host" ref={container} />;
}
