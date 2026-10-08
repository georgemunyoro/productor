// Run with `pnpm test` (needs bun). These cover the interface's pure logic;
// the backend's tests live with the Rust code and run with `cargo test`.
import { describe, expect, test } from "bun:test";
import { rankFiles, tokenAt } from "../src/components/Composer";
import { prChips } from "../src/components/PrStatusMarks";
import { buildItems } from "../src/components/Transcript";
import { parseDiff } from "../src/diff";
import { conversationMarkdown } from "../src/exportChat";
import { highlightLine, languageFor } from "../src/highlight";
import type { AgentEvent, PrStatus } from "../src/types";

describe("composer completions", () => {
  test("finds the file or command being typed at the caret", () => {
    expect(tokenAt("look at @src/ma", 15)).toEqual({ kind: "file", query: "src/ma", start: 8 });
    expect(tokenAt("@", 1)).toEqual({ kind: "file", query: "", start: 0 });
    expect(tokenAt("/rev", 4)).toEqual({ kind: "command", query: "rev", start: 0 });
  });

  test("ignores an @ inside a word and a slash that is not first", () => {
    expect(tokenAt("mail me@example", 15)).toBeNull();
    expect(tokenAt("see /review", 11)).toBeNull();
    expect(tokenAt("/review this", 12)).toBeNull();
  });

  test("ranks a matching file name above a matching directory", () => {
    const files = ["login/helpers.py", "views/login.py", "docs/guide.md", "views/relogin.py"];
    expect(rankFiles(files, "login")).toEqual(["views/login.py", "views/relogin.py", "login/helpers.py"]);
    expect(rankFiles(files, "zzz")).toEqual([]);
  });
});

describe("diff parsing", () => {
  const diff = [
    "diff --git a/a.txt b/a.txt",
    "index 1..2 100644",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,3 +1,4 @@",
    " one",
    "-two",
    "+TWO",
    " three",
    "+four",
    "diff --git a/old name.txt b/new.txt",
    "similarity index 100%",
    "rename from old name.txt",
    "rename to new.txt",
    "diff --git a/img.png b/img.png",
    "Binary files a/img.png and b/img.png differ",
  ].join("\n");

  test("numbers lines on both sides and counts changes", () => {
    const [file] = parseDiff(diff);
    expect(file.path).toBe("a.txt");
    expect([file.additions, file.deletions]).toEqual([2, 1]);
    expect(file.hunks[0].lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ["ctx", 1, 1],
      ["del", 2, undefined],
      ["add", undefined, 2],
      ["ctx", 3, 3],
      ["add", undefined, 4],
    ]);
  });

  test("recognises renames and binary files", () => {
    const [, renamed, binary] = parseDiff(diff);
    expect([renamed.status, renamed.oldPath, renamed.path]).toEqual(["renamed", "old name.txt", "new.txt"]);
    expect(binary.binary).toBe(true);
  });
});

describe("transcript", () => {
  const assistant = (content: unknown[], parent: string | null = null): AgentEvent => ({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { content, usage: { input_tokens: 10, cache_read_input_tokens: 990 } },
  });
  const events: AgentEvent[] = [
    { type: "productor_user", text: "do it", attachments: [] },
    assistant([{ type: "tool_use", id: "task", name: "Task", input: { description: "look around" } }]),
    assistant([{ type: "tool_use", id: "inner", name: "Grep", input: { pattern: "x" } }], "task"),
    { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "task", content: "found", is_error: false }] } },
    assistant([{ type: "tool_use", id: "todo", name: "TodoWrite", input: { todos: [{ content: "a", status: "completed" }] } }]),
    assistant([{ type: "text", text: "Done." }]),
    { type: "result", subtype: "success", is_error: false, duration_ms: 65_000, modelUsage: { m: { contextWindow: 100_000 } } },
    { type: "productor_snapshot", turn: 1 },
    { type: "productor_user", text: "again", attachments: [] },
    { type: "productor_interrupted" },
  ];
  const items = buildItems(events);

  test("nests a subagent's steps under the tool call that started it", () => {
    const task = items.find((i) => i.kind === "tool" && i.name === "Task");
    expect(task?.kind === "tool" && task.steps.map((s) => s.kind)).toEqual(["tool"]);
    expect(task?.kind === "tool" && task.result).toBe("found");
    expect(items.filter((i) => i.kind === "tool")).toHaveLength(1);
  });

  test("turns a task list into a checklist and a result into a turn end", () => {
    expect(items.some((i) => i.kind === "todos")).toBe(true);
    const end = items.find((i) => i.kind === "turnEnd");
    expect(end).toMatchObject({ turn: 1, hasSnapshot: true, meta: "1m 5s · 1k of 100k context (1%)" });
  });

  test("numbers each message by the turn it starts, and marks a cut-off turn", () => {
    expect(items.filter((i) => i.kind === "user").map((i) => i.kind === "user" && i.turn)).toEqual([1, 2]);
    expect(items[items.length - 1]).toMatchObject({ kind: "notice", error: true });
  });
});

describe("pull request chips", () => {
  const pr: PrStatus = {
    number: 1, title: "t", url: "u", state: "OPEN", draft: false, ci: "failing", failingChecks: ["lint"],
    review: "changes_requested", unresolvedThreads: ["a", "b"], mergeable: "conflicting", headSha: "x",
  };

  test("lists everything standing in the way of a merge", () => {
    expect(prChips(pr).map((c) => c.label)).toEqual(["CI failing", "Changes requested", "2 unresolved", "Conflicts"]);
  });

  test("a merged or closed pull request shows only that", () => {
    expect(prChips({ ...pr, state: "MERGED" }).map((c) => c.label)).toEqual(["Merged"]);
  });
});

test("exports a conversation without its tool calls", () => {
  const markdown = conversationMarkdown("Fix it", [
    { type: "productor_user", text: "please fix" },
    { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] } },
    { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Looking." }] } },
    { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Fixed." }] } },
  ]);
  expect(markdown).toBe("# Fix it\n\n## You\n\nplease fix\n\n## Agent\n\nLooking.\n\nFixed.\n");
});

test("highlights known languages and escapes everything else", () => {
  expect(languageFor("src/app.tsx")).toBe("tsx");
  expect(languageFor("notes.unknownext")).toBeUndefined();
  expect(highlightLine("const a = 1;", "ts")).toContain("hljs-keyword");
  expect(highlightLine("<b>&", undefined)).toBe("&lt;b&gt;&amp;");
});
