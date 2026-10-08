import { confirm } from "@tauri-apps/plugin-dialog";
import { memo, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { highlightLine, languageFor } from "../highlight";
import type { DiffFile, DiffLine } from "../diff";
import { usePanel, type ReviewComment } from "../panelStore";
import { useStore, workspaceStatus } from "../store";
import { AGENT_NAMES, type Workspace } from "../types";

const NO_COMMENTS: ReviewComment[] = [];
const LARGE_FILE_LINES = 800;

export function DiffPanel({ workspace }: { workspace: Workspace }) {
  const diff = usePanel((s) => s.diffs[workspace.id]);
  const comments = usePanel((s) => s.comments[workspace.id]) ?? NO_COMMENTS;
  const chatId = useStore((s) => s.selectedChatIds[workspace.id]);
  const agent = useStore((s) => s.chats.find((c) => c.id === chatId)?.agent ?? "claude");
  const status = useStore((s) => workspaceStatus(workspace.id, s.chats, s.statuses));
  const { loadDiff, sendReview } = usePanel.getState();

  // Reload when the panel opens and whenever an agent in the workspace
  // starts or finishes a turn.
  useEffect(() => {
    void loadDiff(workspace.id);
  }, [workspace.id, status, loadDiff]);

  const files = diff?.files ?? [];
  const uncommitted = diff?.uncommitted ?? [];
  const [committing, setCommitting] = useState(false);
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState<"commit" | "push" | "discard" | null>(null);
  const { reportError } = useStore.getState();

  /** Runs a git action, then reloads the diff; resolves to whether it worked. */
  const run = async (kind: "commit" | "push" | "discard", action: () => Promise<void>) => {
    setWorking(kind);
    try {
      await action();
      return true;
    } catch (e) {
      reportError(e);
      return false;
    } finally {
      setWorking(null);
      void loadDiff(workspace.id);
    }
  };

  const discard = async (path: string) => {
    const ok = await confirm(
      `Uncommitted changes to ${path} will be thrown away. If the file was never committed, it is deleted. This cannot be undone.`,
      { title: "Discard changes?", kind: "warning", okLabel: "Discard" },
    );
    if (ok) await run("discard", () => api.discardFile(workspace.id, path));
  };
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);

  return (
    <div className="panel-body">
      <div className="panel-toolbar">
        <span className="panel-summary">
          {files.length === 0
            ? diff?.loading
              ? "Loading…"
              : "No changes"
            : `${files.length} file${files.length === 1 ? "" : "s"} changed`}
          {files.length > 0 && (
            <>
              <span className="stat-add"> +{additions}</span>
              <span className="stat-del"> −{deletions}</span>
            </>
          )}
        </span>
        {comments.length > 0 && chatId && (
          <button
            className="button primary small"
            disabled={status !== "idle"}
            title={status !== "idle" ? "Wait for the agent to finish its turn" : undefined}
            onClick={() => sendReview(workspace.id, chatId)}
          >
            Send {comments.length} comment{comments.length === 1 ? "" : "s"} to{" "}
            {AGENT_NAMES[agent]}
          </button>
        )}
        <button
          className="button small"
          disabled={uncommitted.length === 0 || working !== null}
          title={
            uncommitted.length === 0
              ? "Nothing uncommitted"
              : `Commit ${uncommitted.length} changed file${uncommitted.length === 1 ? "" : "s"}`
          }
          onClick={() => setCommitting(!committing)}
        >
          Commit…
        </button>
        <button
          className="button small"
          disabled={working !== null || diff?.unpushed === 0}
          title={
            diff?.unpushed === 0
              ? "Everything committed is already pushed"
              : diff?.unpushed
                ? `Push ${diff.unpushed} commit${diff.unpushed === 1 ? "" : "s"}`
                : "Push this branch for the first time"
          }
          onClick={() => run("push", () => api.pushWorkspace(workspace.id))}
        >
          {working === "push" ? "Pushing…" : "Push"}
        </button>
        <button className="button small" disabled={diff?.loading} onClick={() => loadDiff(workspace.id)}>
          Refresh
        </button>
      </div>
      {committing && (
        <form
          className="script-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!message.trim()) return;
            void run("commit", () => api.commitWorkspace(workspace.id, message)).then((ok) => {
              if (!ok) return;
              setMessage("");
              setCommitting(false);
            });
          }}
        >
          <input
            autoFocus
            aria-label="Commit message"
            placeholder="Commit message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setCommitting(false)}
          />
          <button type="submit" className="button primary small" disabled={!message.trim() || working !== null}>
            {working === "commit" ? "Committing…" : "Commit all"}
          </button>
        </form>
      )}
      <div className="diff-scroll">
        {diff?.error && <p className="panel-error">{diff.error}</p>}
        {!diff?.error && files.length === 0 && !diff?.loading && (
          <p className="panel-empty">
            Changes this workspace makes relative to its base branch will appear here.
          </p>
        )}
        {files.map((file) => (
          <FileDiff
            key={file.path}
            file={file}
            workspaceId={workspace.id}
            comments={comments.filter((c) => c.path === file.path)}
            onDiscard={uncommitted.includes(file.path) ? () => discard(file.path) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

const FileDiff = memo(function FileDiff(props: {
  file: DiffFile;
  workspaceId: string;
  comments: ReviewComment[];
  /** Present when the file has uncommitted changes to throw away. */
  onDiscard?: () => void;
}) {
  const { file, workspaceId, comments, onDiscard } = props;
  const language = useMemo(() => languageFor(file.path), [file.path]);
  const lineCount = file.hunks.reduce((n, h) => n + h.lines.length, 0);
  const [open, setOpen] = useState(lineCount <= LARGE_FILE_LINES);
  const [draftAt, setDraftAt] = useState<string | null>(null);
  const { addComment, removeComment } = usePanel.getState();

  return (
    <section className="diff-file">
      <div className="diff-file-header">
        <button className="diff-file-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="chevron" aria-hidden />
          <span className="diff-path">
            {file.oldPath && file.status === "renamed" ? `${file.oldPath} → ` : ""}
            {file.path}
          </span>
          {file.status !== "modified" && <span className={`badge ${file.status}`}>{file.status}</span>}
          <span className="stat-add">+{file.additions}</span>
          <span className="stat-del">−{file.deletions}</span>
        </button>
        {onDiscard && (
          <button className="button small" title="Throw away this file's uncommitted changes" onClick={onDiscard}>
            Discard
          </button>
        )}
      </div>
      {open && file.binary && <p className="panel-empty">Binary file</p>}
      {open && !file.binary && file.hunks.length === 0 && (
        <p className="panel-empty">No content changes</p>
      )}
      {open &&
        file.hunks.map((hunk, h) => (
          <div key={h} className="hunk">
            <div className="hunk-header">{hunk.header}</div>
            {hunk.lines.map((line, i) => {
              const side = line.kind === "del" ? "old" : "new";
              const number = (side === "old" ? line.oldNo : line.newNo) ?? 0;
              const key = `${side}:${number}`;
              const here = comments.filter((c) => c.side === side && c.line === number);
              return (
                <div key={i}>
                  <DiffRow line={line} language={language} onComment={() => setDraftAt(key)} />
                  {here.map((c) => (
                    <div key={c.id} className="comment">
                      <span className="comment-text">{c.text}</span>
                      <button
                        className="icon-button"
                        title="Delete comment"
                        onClick={() => removeComment(workspaceId, c.id)}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {draftAt === key && (
                    <CommentDraft
                      onCancel={() => setDraftAt(null)}
                      onSave={(text) => {
                        addComment(workspaceId, {
                          path: file.path,
                          line: number,
                          side,
                          lineText: line.text,
                          text,
                        });
                        setDraftAt(null);
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        ))}
    </section>
  );
});

const DiffRow = memo(function DiffRow(props: { line: DiffLine; language?: string; onComment: () => void }) {
  const { line, language, onComment } = props;
  const html = useMemo(() => highlightLine(line.text, language), [line.text, language]);
  return (
    <div className={`diff-row ${line.kind}`}>
      <span className="line-no">{line.oldNo ?? ""}</span>
      <span className="line-no">{line.newNo ?? ""}</span>
      <button className="add-comment" title="Comment on this line" onClick={onComment}>
        +
      </button>
      {/* highlightLine escapes the text, so this is markup we made ourselves. */}
      <span className="line-text hljs" dangerouslySetInnerHTML={{ __html: html || " " }} />
    </div>
  );
});

function CommentDraft(props: { onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const save = () => text.trim() && props.onSave(text.trim());
  return (
    <div className="comment draft">
      <textarea
        autoFocus
        rows={2}
        value={text}
        placeholder="Leave a comment for the agent…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
          if (e.key === "Escape") props.onCancel();
        }}
      />
      <div className="comment-actions">
        <button className="button small" onClick={props.onCancel}>
          Cancel
        </button>
        <button className="button primary small" disabled={!text.trim()} onClick={save}>
          Add comment
        </button>
      </div>
    </div>
  );
}
