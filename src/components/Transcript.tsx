import { memo, useMemo, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { api } from "../api";
import { useStore } from "../store";
import type { AgentEvent } from "../types";
import { CopyButton } from "./CopyButton";

interface ToolItem {
  kind: "tool";
  key: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  /** What a subagent started by this tool did. */
  steps: Item[];
}

interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

type Item =
  | { kind: "user"; key: string; text: string; attachments: string[]; turn: number }
  | { kind: "text"; key: string; text: string }
  | { kind: "thinking"; key: string; text: string }
  | { kind: "todos"; key: string; todos: Todo[] }
  | ToolItem
  | { kind: "notice"; key: string; text: string; error: boolean }
  /** End of a turn: a point the chat can be forked from. */
  | { kind: "turnEnd"; key: string; turn: number; hasSnapshot: boolean; meta: string };

type TurnEnd = Extract<Item, { kind: "turnEnd" }>;

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block?.type === "text" ? block.text : `[${block?.type ?? "content"}]`))
    .join("\n");
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** How long a turn took and how full the agent's context was after it. */
function turnMeta(result: AgentEvent, lastUsage: AgentEvent | undefined): string {
  const parts: string[] = [];
  if (typeof result.duration_ms === "number") parts.push(duration(result.duration_ms));
  // Claude reports usage on each message; Codex reports it for the turn.
  const usage = lastUsage ?? result.usage;
  if (usage) {
    const used =
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0);
    const windows = Object.values(result.modelUsage ?? {}).map(
      (m) => (m as { contextWindow?: number }).contextWindow ?? 0,
    );
    const window = Math.max(0, ...windows);
    if (used > 0) {
      parts.push(
        window > 0
          ? `${compact(used)} of ${compact(window)} context (${Math.round((used / window) * 100)}%)`
          : `${compact(used)} context`,
      );
    }
  }
  return parts.join(" · ");
}

export function buildItems(events: AgentEvent[]): Item[] {
  const items: Item[] = [];
  const tools = new Map<string, ToolItem>();
  const turnEnds = new Map<number, TurnEnd>();
  let turn = 0;
  let lastUsage: AgentEvent | undefined;

  events.forEach((event, i) => {
    const key = String(i);
    // A subagent's activity is listed under the tool call that started it.
    const parent = event.parent_tool_use_id ? tools.get(event.parent_tool_use_id) : undefined;
    if (event.parent_tool_use_id && !parent) return;
    const into = parent ? parent.steps : items;

    if (event.type === "productor_user") {
      items.push({
        kind: "user",
        key,
        text: event.text,
        attachments: event.attachments ?? [],
        turn: turn + 1,
      });
    } else if (event.type === "assistant") {
      if (!parent && event.message?.usage) lastUsage = event.message.usage;
      const blocks = event.message?.content ?? [];
      blocks.forEach((block: AgentEvent, j: number) => {
        if (block.type === "text" && block.text.trim()) {
          into.push({ kind: "text", key: `${key}.${j}`, text: block.text });
        } else if (block.type === "thinking" && block.thinking?.trim()) {
          into.push({ kind: "thinking", key: `${key}.${j}`, text: block.thinking });
        } else if (block.type === "tool_use") {
          if (block.name === "TodoWrite" && Array.isArray(block.input?.todos)) {
            into.push({ kind: "todos", key: `${key}.${j}`, todos: block.input.todos });
            return;
          }
          const item: ToolItem = {
            kind: "tool",
            key: `${key}.${j}`,
            name: block.name,
            input: block.input ?? {},
            steps: [],
          };
          tools.set(block.id, item);
          into.push(item);
        }
      });
    } else if (event.type === "user") {
      const content = event.message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const tool = tools.get(block.tool_use_id);
        if (tool) {
          tool.result = resultText(block.content);
          tool.isError = Boolean(block.is_error);
        }
      }
    } else if (event.type === "result") {
      if (event.is_error || event.subtype !== "success") {
        const interrupted = event.subtype === "error_during_execution";
        items.push({
          kind: "notice",
          key,
          error: !interrupted,
          text: interrupted ? "Stopped" : String(event.result ?? event.subtype),
        });
      }
      const end: TurnEnd = {
        kind: "turnEnd",
        key: `${key}.end`,
        turn: ++turn,
        hasSnapshot: false,
        meta: turnMeta(event, lastUsage),
      };
      lastUsage = undefined;
      turnEnds.set(end.turn, end);
      items.push(end);
    } else if (event.type === "productor_snapshot") {
      const end = turnEnds.get(event.turn);
      if (end) end.hasSnapshot = true;
    } else if (event.type === "productor_interrupted") {
      items.push({
        kind: "notice",
        key,
        error: true,
        text: "This turn was cut off when Productor closed. Use Retry on your message to run it again.",
      });
    } else if (event.type === "productor_notice") {
      items.push({ kind: "notice", key, error: false, text: event.text });
    } else if (event.type === "productor_error") {
      items.push({ kind: "notice", key, error: true, text: event.message });
    } else if (event.type === "system" && event.subtype === "compact_boundary") {
      items.push({ kind: "notice", key, error: false, text: "Conversation compacted" });
    }
  });
  return items;
}

function relative(path: string, root: string) {
  return path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
}

function toolSummary(item: ToolItem, root: string): string {
  const str = (key: string) => (typeof item.input[key] === "string" ? (item.input[key] as string) : "");
  if (str("command")) return str("command");
  if (str("file_path")) return relative(str("file_path"), root);
  if (str("pattern")) return str("pattern");
  if (str("description")) return str("description");
  if (str("url")) return str("url");
  if (str("query")) return str("query");
  return "";
}

function ToolRow(props: { item: ToolItem; root: string }) {
  const { item, root } = props;
  const [open, setOpen] = useState(false);
  const pending = item.result === undefined;
  const steps = item.steps.filter((s) => s.kind === "tool").length;
  return (
    <div className={"tool" + (item.isError ? " failed" : "")}>
      <button className="tool-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="tool-name" data-tool={item.name}>
          {item.name}
        </span>
        <span className="tool-summary">{toolSummary(item, root)}</span>
        {steps > 0 && (
          <span className="tool-state">
            {steps} step{steps === 1 ? "" : "s"}
          </span>
        )}
        {pending && <span className="tool-state running">running</span>}
        {item.isError && <span className="tool-state">failed</span>}
        <span className="chevron" aria-hidden>
          ▸
        </span>
      </button>
      {open && (
        <div className="tool-detail">
          <pre>{JSON.stringify(item.input, null, 2)}</pre>
          {item.steps.length > 0 && (
            <div className="tool-steps">
              <Items items={item.steps} root={root} />
            </div>
          )}
          {item.result !== undefined && (
            <div className="tool-output">
              <CopyButton text={item.result} />
              <pre>{item.result || "(no output)"}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A fenced code block, with a button to copy what it contains. */
function CodeBlock(props: React.ComponentProps<"pre">) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="code-block">
      <CopyButton text={() => ref.current?.innerText ?? ""} />
      <pre ref={ref} {...props} />
    </div>
  );
}

const MARKDOWN: Components = {
  pre: CodeBlock,
  // Links leave the app: they open in the browser, never inside the window.
  a: ({ href, children }) => (
    <a
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) api.openUrl(href).catch(useStore.getState().reportError);
      }}
    >
      {children}
    </a>
  ),
};

const Prose = memo(function Prose({ text, copyable }: { text: string; copyable?: boolean }) {
  return (
    <div className="prose">
      {copyable && <CopyButton text={text} className="prose-copy" />}
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={MARKDOWN}>
        {text}
      </Markdown>
    </div>
  );
});

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thinking">
      <button onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="chevron" aria-hidden>
          ▸
        </span>
        Thinking
      </button>
      {open && <div className="thinking-text">{text}</div>}
    </div>
  );
}

const TODO_GLYPH: Record<Todo["status"], string> = { pending: "○", in_progress: "◐", completed: "●" };

function Todos({ todos }: { todos: Todo[] }) {
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <div className="todos">
      <div className="todos-title">
        Tasks · {done} of {todos.length} done
      </div>
      <ul>
        {todos.map((todo, i) => (
          <li key={i} className={todo.status}>
            <span aria-hidden>{TODO_GLYPH[todo.status]}</span>
            <span className="visually-hidden">{todo.status.replace("_", " ")}: </span>
            {todo.content}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface Actions {
  /** Forks the chat after the given turn; omitted while a fork is under way. */
  onFork?: (turn: number, withWorktree: boolean) => void;
  /** Whether the chat's agent is able to fork from this turn. */
  canFork?: (turn: number) => boolean;
  /** Sends a message again; omitted while the agent is busy. */
  onRetry?: (text: string, attachments: string[]) => void;
  /** Starts over from before a message, with its text ready to change. */
  onEdit?: (turn: number, text: string) => void;
  /** Key of the most recent user message. */
  lastUserKey?: string;
}

function Items(props: { items: Item[]; root: string } & Actions) {
  const { items, root, onFork, canFork, onRetry, onEdit, lastUserKey } = props;
  return (
    <>
      {items.map((item) => {
        switch (item.kind) {
          case "user":
            return (
              <div key={item.key} className="user-turn">
                <div className="message-user">
                  {item.text}
                  {item.attachments.length > 0 && (
                    <span className="message-attachments">
                      {item.attachments.map((path) => (
                        <span key={path} title={path}>
                          {path.slice(path.lastIndexOf("/") + 1)}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
                <div className="message-actions">
                  <CopyButton text={item.text} />
                  {onEdit && (
                    <button
                      className="copy-button"
                      title="Start again from before this message, in a new chat, with its text ready to edit"
                      onClick={() => onEdit(item.turn, item.text)}
                    >
                      Edit
                    </button>
                  )}
                  {onRetry && item.key === lastUserKey && (
                    <button
                      className="copy-button"
                      title="Send this message again"
                      onClick={() => onRetry(item.text, item.attachments)}
                    >
                      Retry
                    </button>
                  )}
                </div>
              </div>
            );
          case "text":
            return <Prose key={item.key} text={item.text} copyable />;
          case "thinking":
            return <Thinking key={item.key} text={item.text} />;
          case "todos":
            return <Todos key={item.key} todos={item.todos} />;
          case "tool":
            return <ToolRow key={item.key} item={item} root={root} />;
          case "turnEnd": {
            const forkable = canFork?.(item.turn) ?? false;
            return (
              <div key={item.key} className="turn-end">
                {forkable && (
                  <span className="turn-actions">
                    <button
                      disabled={!onFork}
                      title="Continue from here in a new chat, in this same directory"
                      onClick={() => onFork?.(item.turn, false)}
                    >
                      Fork chat
                    </button>
                    {item.hasSnapshot && (
                      <button
                        disabled={!onFork}
                        title="Continue from here in a new workspace, with the code as it was at this point"
                        onClick={() => onFork?.(item.turn, true)}
                      >
                        Fork into new workspace
                      </button>
                    )}
                  </span>
                )}
                {item.meta && <span className="turn-meta">{item.meta}</span>}
              </div>
            );
          }
          case "notice":
            return (
              <div key={item.key} className={"notice" + (item.error ? " error" : "")}>
                {item.text}
              </div>
            );
        }
      })}
    </>
  );
}

/**
 * The reply being streamed. It subscribes to the text itself, so each new
 * word re-renders this alone and not the whole transcript above it.
 */
function Streaming({ chatId }: { chatId: string }) {
  const partial = useStore((s) => s.partials[chatId] ?? "");
  return partial ? <Prose text={partial} /> : null;
}

const History = memo(function History(
  props: {
    events: AgentEvent[];
    root: string;
    /** Changes when what may be forked or retried changes without new events. */
    revision: string;
  } & Actions,
) {
  const { events, root, revision: _revision, ...actions } = props;
  const items = useMemo(() => buildItems(events), [events]);
  const lastUserKey = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === "user") return items[i].key;
    return undefined;
  }, [items]);
  return <Items items={items} root={root} lastUserKey={lastUserKey} {...actions} />;
});

export function Transcript(
  props: { chatId: string; events: AgentEvent[]; workspacePath: string } & Actions,
) {
  const { chatId, events, workspacePath, onFork, canFork, onRetry, onEdit } = props;
  // The callbacks are new functions on every render of the chat view. Keep
  // the latest in a ref and hand the history stable ones, so it re-renders
  // only when its events or what is allowed actually change.
  const latest = useRef({ onFork, canFork, onRetry, onEdit });
  latest.current = { onFork, canFork, onRetry, onEdit };
  const stable = useMemo<Actions>(
    () => ({
      onFork: (turn, withWorktree) => latest.current.onFork?.(turn, withWorktree),
      canFork: (turn) => latest.current.canFork?.(turn) ?? false,
      onRetry: (text, attachments) => latest.current.onRetry?.(text, attachments),
      onEdit: (turn, text) => latest.current.onEdit?.(turn, text),
    }),
    [],
  );
  // Whether each action is on offer is part of what the history shows.
  const forkable = onFork !== undefined;
  const retryable = onRetry !== undefined;
  const editable = onEdit !== undefined;
  // `canFork` depends on state outside the events (a Codex chat's turn count
  // and whether it is busy), which this stands in for.
  const revision = `${events.length}:${retryable}`;
  return (
    <>
      <History
        key={chatId}
        events={events}
        root={workspacePath}
        onFork={forkable ? stable.onFork : undefined}
        canFork={stable.canFork}
        onRetry={retryable ? stable.onRetry : undefined}
        onEdit={editable ? stable.onEdit : undefined}
        revision={revision}
      />
      <Streaming chatId={chatId} />
    </>
  );
}
