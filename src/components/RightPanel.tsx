import { useStore } from "../store";
import { usePanel, type PanelTab } from "../panelStore";
import { DiffPanel } from "./DiffPanel";
import { FilesPanel } from "./FilesPanel";
import { TerminalPanel } from "./TerminalPanel";

const TABS: { id: PanelTab; label: string }[] = [
  { id: "changes", label: "Changes" },
  { id: "files", label: "Files" },
  { id: "terminal", label: "Terminal" },
];

export function RightPanel() {
  const workspace = useStore((s) => s.workspaces.find((w) => w.id === s.selectedWorkspaceId));
  const open = usePanel((s) => s.open);
  const tab = usePanel((s) => s.tab);
  const width = usePanel((s) => s.width);
  const { setTab, setWidth } = usePanel.getState();

  if (!workspace || !open) return null;

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) =>
      setWidth(Math.max(320, Math.min(window.innerWidth - 560, window.innerWidth - ev.clientX)));
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
  };

  return (
    <>
      <div className="resizer" onPointerDown={startResize} role="separator" aria-orientation="vertical" />
      <section className="panel" style={{ width }}>
        <header className="panel-header" data-tauri-drag-region>
          <nav className="tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={"tab" + (t.id === tab ? " selected" : "")}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </header>
        {/* Keyed by workspace so each panel starts clean when switching. */}
        {tab === "changes" && <DiffPanel key={workspace.id} workspace={workspace} />}
        {tab === "files" && <FilesPanel key={workspace.id} workspace={workspace} />}
        {tab === "terminal" && <TerminalPanel key={workspace.id} workspace={workspace} />}
      </section>
    </>
  );
}
