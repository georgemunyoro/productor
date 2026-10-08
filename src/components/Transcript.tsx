import { memo, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentEvent } from "../types";

type Item =
  | { kind: "user"; key: string; text: string }
  | { kind: "text"; key: string; text: string }
  | {
      kind: "tool";
      key: string;
      name: string;
      input: Record<string, unknown>;
      result?: string;
      isError?: boolean;
    }
  | { kind: "notice"; key: string; text: string; error: boolean }
  /** End of a turn: a point the chat can be forked from. */
  | { kind: "turnEnd"; key: string; turn: number; hasSnapshot: boolean };

type TurnEnd = Extract<Item, { kind: "turnEnd" }>;

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block?.type === "text" ? block.text : `[${block?.type ?? "content"}]`))
    .join("\n");
}

function buildItems(events: AgentEvent[]): Item[] {
  const items: Item[] = [];
  const tools = new Map<string, Extract<Item, { kind: "tool" }>>();
  let turn = 0;
  const turnEnds = new Map<number, TurnEnd>();

  events.forEach((event, i) => {
    const key = String(i);
    // Subagent traffic belongs to the tool call that spawned it.
    if (event.parent_tool_use_id) return;

    if (event.type === "productor_user") {
      items.push({ kind: "user", key, text: event.text });
    } else if (event.type === "assistant") {
      const blocks = event.message?.content ?? [];
      blocks.forEach((block: AgentEvent, j: number) => {
        if (block.type === "text" && block.text.trim()) {
          items.push({ kind: "text", key: `${key}.${j}`, text: block.text });
        } else if (block.type === "tool_use") {
          const item: Item = {
            kind: "tool",
            key: `${key}.${j}`,
            name: block.name,
            input: block.input ?? {},
          };
          tools.set(block.id, item);
          items.push(item);
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
      const end: TurnEnd = { kind: "turnEnd", key: `${key}.end`, turn: ++turn, hasSnapshot: false };
      turnEnds.set(end.turn, end);
      items.push(end);
    } else if (event.type === "productor_snapshot") {
      const end = turnEnds.get(event.turn);
      if (end) end.hasSnapshot = true;
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

function toolSummary(name: string, input: Record<string, unknown>, root: string): string {
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  if (str("command")) return str("command");
  if (str("file_path")) return relative(str("file_path"), root);
  if (str("pattern")) return str("pattern");
  if (str("description")) return str("description");
  if (str("url")) return str("url");
  if (str("query")) return str("query");
  if (name === "TodoWrite") return "update task list";
  return "";
}

function ToolRow(props: { item: Extract<Item, { kind: "tool" }>; root: string }) {
  const { item, root } = props;
  const [open, setOpen] = useState(false);
  const pending = item.result === undefined;
  return (
    <div className={"tool" + (item.isError ? " failed" : "")}>
      <button className="tool-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="tool-name">{item.name}</span>
        <span className="tool-summary">{toolSummary(item.name, item.input, root)}</span>
        {pending && <span className="tool-state">running</span>}
        {item.isError && <span className="tool-state">failed</span>}
      </button>
      {open && (
        <div className="tool-detail">
          <pre>{JSON.stringify(item.input, null, 2)}</pre>
          {item.result !== undefined && <pre>{item.result || "(no output)"}</pre>}
        </div>
      )}
    </div>
  );
}

const Prose = memo(function Prose({ text }: { text: string }) {
  return (
    <div className="prose">
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  );
});

export function Transcript(props: {
  events: AgentEvent[];
  partial: string;
  workspacePath: string;
  /** Forks the chat after the given turn; omitted while a fork is under way. */
  onFork?: (turn: number, withWorktree: boolean) => void;
  /** Whether the chat's agent is able to fork from this turn. */
  canFork: (turn: number) => boolean;
}) {
  const { events, partial, workspacePath, onFork, canFork } = props;
  const items = useMemo(() => buildItems(events), [events]);
  return (
    <>
      {items.map((item) => {
        switch (item.kind) {
          case "user":
            return (
              <div key={item.key} className="message-user">
                {item.text}
              </div>
            );
          case "text":
            return <Prose key={item.key} text={item.text} />;
          case "tool":
            return <ToolRow key={item.key} item={item} root={workspacePath} />;
          case "turnEnd":
            if (!canFork(item.turn)) return null;
            return (
              <div key={item.key} className="turn-end">
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
              </div>
            );
          case "notice":
            return (
              <div key={item.key} className={"notice" + (item.error ? " error" : "")}>
                {item.text}
              </div>
            );
        }
      })}
      {partial && <Prose text={partial} />}
    </>
  );
}
