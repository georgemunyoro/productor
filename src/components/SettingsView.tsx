import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { HealthCheck, Repo, StorageEntry } from "../types";
import { useUi, type Theme } from "../ui";
import { SidebarToggle } from "./SidebarToggle";

const SHORTCUTS: [string, string][] = [
  ["⌘K", "Command palette: go anywhere, run an action, search conversations"],
  ["⌘1 to ⌘9", "Switch to a workspace by its position in the sidebar"],
  ["⌘⇧[ and ⌘⇧]", "Previous and next chat in the workspace"],
  ["⌘T", "New chat in the workspace"],
  ["⌘N", "New workspace in the current repository"],
  ["⌘L", "Focus the message box"],
  ["⌘F", "Find in the chat"],
  ["⌘B", "Show or hide the sidebar"],
  ["⌘J", "Show or hide the side panel"],
  ["⌘,", "Settings"],
];

/** A text field that saves when focus leaves it, if its value changed. */
function SavedField(props: { label: string; hint?: string; value: string; placeholder?: string; mono?: boolean; onSave: (value: string) => void }) {
  const [text, setText] = useState(props.value);
  useEffect(() => setText(props.value), [props.value]);
  return (
    <label>
      {props.label}
      <input
        className={props.mono ? "mono" : ""}
        spellCheck={false}
        value={text}
        placeholder={props.placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text.trim() !== props.value && props.onSave(text.trim())}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
      {props.hint && <span className="hint">{props.hint}</span>}
    </label>
  );
}

function RepoScripts({ repo }: { repo: Repo }) {
  const { refresh, reportError } = useStore.getState();
  const save = (call: Promise<void>) => call.then(refresh, reportError);
  return (
    <fieldset>
      <legend>{repo.name}</legend>
      <SavedField
        mono
        label="Setup script"
        value={repo.setupScript ?? ""}
        placeholder="pnpm install && cp $PRODUCTOR_REPO/.env ."
        hint="Runs in a terminal tab in every new workspace, fork and promoted chat. $PRODUCTOR_REPO is the main repository's path."
        onSave={(script) => save(api.setSetupScript(repo.id, script || null))}
      />
      <SavedField
        mono
        label="Run script"
        value={repo.runScript ?? ""}
        placeholder="pnpm dev"
        hint="What the Run button in the terminal panel starts."
        onSave={(script) => save(api.setRunScript(repo.id, script || null))}
      />
    </fieldset>
  );
}

function size(kb: number): string {
  if (kb >= 1_000_000) return `${(kb / 1_048_576).toFixed(1)} GB`;
  if (kb >= 1000) return `${Math.round(kb / 1024)} MB`;
  return `${kb} KB`;
}

/** Whether each tool Productor drives is installed and logged in. */
function Health() {
  const [checks, setChecks] = useState<HealthCheck[] | null>(null);
  const problems = useStore((s) => s.problems);
  const run = () => {
    setChecks(null);
    api.health().then(setChecks, () => setChecks([]));
  };
  useEffect(run, []);
  return (
    <section className="form">
      <h2>Health</h2>
      {checks === null && <span className="hint">Checking…</span>}
      {checks && (
        <ul className="health">
          {checks.map((check) => (
            <li key={check.name}>
              <span className={`dot ${check.ok ? "done" : "failed"}`} aria-hidden />
              <span className="health-text">
                <strong>{check.name}</strong> <span className="hint">{check.detail}</span>
                {check.fix && <span className="health-fix">{check.fix}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {Object.entries(problems).map(([what, problem]) => (
        <p key={what} className="panel-error left">
          {what === "inbox" ? "Checking for review requests is failing" : "Checking pull requests is failing"}: {problem}
        </p>
      ))}
      <div className="form-actions">
        <button className="button small" disabled={checks === null} onClick={run}>
          Check again
        </button>
      </div>
    </section>
  );
}

/** Disk used by each workspace, largest first, with a way to free it. */
function Storage() {
  const [entries, setEntries] = useState<StorageEntry[] | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const { archiveWorkspace, reportError } = useStore.getState();
  const measure = () => {
    setMeasuring(true);
    api
      .storage()
      .then(setEntries, reportError)
      .finally(() => setMeasuring(false));
  };
  const total = entries?.reduce((sum, e) => sum + e.kb, 0) ?? 0;
  return (
    <section className="form">
      <h2>Storage</h2>
      <span className="hint">
        Every workspace is a full checkout of its repository, so large repositories add up.
        Archiving a workspace frees its space; its branch and uncommitted work are kept and it can
        be restored below.
      </span>
      {entries && (
        <ul className="member-list">
          {entries.map((entry) => (
            <li key={entry.path} className="automation">
              <span className="automation-text">
                <span className="member-name">{entry.name}</span>
                <span className="member-detail">{entry.path}</span>
              </span>
              <strong className="storage-size">{size(entry.kb)}</strong>
              {entry.workspaceId && (
                <button
                  className="button small"
                  onClick={async () => {
                    await archiveWorkspace(entry.workspaceId!);
                    measure();
                  }}
                >
                  Archive
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="form-actions">
        {entries && <span className="hint">{size(total)} in total</span>}
        <span className="spacer" />
        <button className="button small" disabled={measuring} onClick={measure}>
          {measuring ? "Measuring…" : entries ? "Measure again" : "Measure"}
        </button>
      </div>
    </section>
  );
}

export function SettingsView() {
  const settings = useStore((s) => s.settings);
  const repos = useStore((s) => s.repos);
  const workspaces = useStore((s) => s.workspaces);
  const theme = useUi((s) => s.theme);
  const { setSettings, restoreWorkspace } = useStore.getState();
  const [restoring, setRestoring] = useState<string | null>(null);
  const archived = workspaces.filter((w) => w.archived).reverse();

  return (
    <div className="chat">
      <header className="chat-header" data-tauri-drag-region>
        <SidebarToggle whenSidebar="hidden" />
        <div className="chat-heading" data-tauri-drag-region>
          <strong>Settings</strong>
        </div>
      </header>
      <div className="transcript">
        <div className="transcript-inner settings">
          <Health />

          <section className="form">
            <h2>Appearance</h2>
            <label>
              Theme
              <select value={theme} onChange={(e) => useUi.getState().setTheme(e.target.value as Theme)}>
                <option value="system">Match the system</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
          </section>

          <section className="form">
            <h2>Agents</h2>
            <label className="check">
              <input
                type="checkbox"
                checked={settings.useApiKey}
                onChange={(e) => setSettings({ ...settings, useApiKey: e.target.checked })}
              />
              Let Claude use an API key from my shell environment
            </label>
            <span className="hint">
              Off, Claude runs on your subscription login even when ANTHROPIC_API_KEY is set. On,
              that key is billed instead.
            </span>
            <span className="hint">
              The agent, model and fast mode are chosen in each chat's message box; new chats start
              with what you picked last.
            </span>
            <SavedField
              mono
              label="Editor command"
              value={settings.editor}
              placeholder="code"
              hint="Used by “Open in editor” on a workspace, for example code, cursor or zed."
              onSave={(editor) => setSettings({ ...settings, editor })}
            />
          </section>

          <section className="form">
            <h2>Repositories</h2>
            {repos.length === 0 && <span className="hint">No repositories added yet.</span>}
            {repos.map((repo) => (
              <RepoScripts key={repo.id} repo={repo} />
            ))}
          </section>

          <Storage />

          <section className="form">
            <h2>Archived workspaces</h2>
            {archived.length === 0 && <span className="hint">Nothing archived.</span>}
            <ul className="member-list">
              {archived.map((ws) => (
                <li key={ws.id} className="automation">
                  <span className="automation-text">
                    <span className="member-name">{ws.name}</span>
                    <span className="member-detail">
                      {repos.find((r) => r.id === ws.repoId)?.name} · {ws.branch}
                    </span>
                  </span>
                  <button
                    className="button small"
                    disabled={restoring !== null}
                    title="Check the branch out again, with any uncommitted work it had when archived"
                    onClick={async () => {
                      setRestoring(ws.id);
                      await restoreWorkspace(ws.id);
                      setRestoring(null);
                    }}
                  >
                    {restoring === ws.id ? "Restoring…" : "Restore"}
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="form">
            <h2>Keyboard shortcuts</h2>
            <dl className="shortcuts">
              {SHORTCUTS.map(([keys, what]) => (
                <div key={keys}>
                  <dt>{keys}</dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
