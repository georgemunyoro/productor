/**
 * A stand-in for the Tauri backend, for running the interface in an ordinary
 * browser during development: `pnpm dev`, then open the page outside the app.
 * It serves fixture data and plays back a canned reply, which is enough to
 * look at and click through every screen. It is never part of a build.
 */
import type { AgentEvent, Chat, InboxItem, PrStatus, Repo, Workspace } from "../types";

type Handler = (event: { event: string; payload: unknown; id: number }) => void;

const callbacks = new Map<number, Handler>();
const listeners = new Map<string, number[]>();
let nextId = 1;

function emit(event: string, payload: unknown) {
  for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, payload, id });
}

const now = Date.now();
const repos: Repo[] = [
  { id: "r1", name: "posthog", path: "/Users/dev/code/posthog", runScript: "pnpm dev", setupScript: "pnpm install" },
  { id: "r2", name: "productor", path: "/Users/dev/code/productor", runScript: null, setupScript: null },
];
const workspace = (id: string, repoId: string, name: string, branch: string, extra: Partial<Workspace> = {}): Workspace => ({
  id, repoId, name, branch, path: `/Users/dev/productor/workspaces/${name}`, createdAt: now, archived: false,
  groupId: null, autoPr: false, autoPush: false, linkedPr: null, ...extra,
});
const workspaces: Workspace[] = [
  workspace("w1", "r1", "havana", "george/havana", { groupId: "g1", autoPr: true }),
  workspace("w2", "r1", "lisbon", "george/lisbon", { groupId: "g1" }),
  workspace("w3", "r1", "Review #105800 reject invalid regexes", "george/kigali", { linkedPr: { repo: "posthog/posthog", number: 105800 } }),
  workspace("w4", "r2", "nairobi", "george/nairobi"),
  workspace("w5", "r2", "oslo", "george/oslo", { archived: true }),
];
const chat = (id: string, extra: Partial<Chat>): Chat => ({
  id, agent: "claude", workspaceId: null, repoId: null, cwd: null, title: null, sessionId: "s", createdAt: now,
  turns: 0, groupId: null, plan: false, linkedPr: null, model: null, fast: null, inboxId: null, ...extra,
});
const chats: Chat[] = [
  chat("c1", { workspaceId: "w1", title: "Fix the login redirect loop", turns: 2 }),
  chat("c2", { workspaceId: "w1", title: "Add tests for the redirect", turns: 1, agent: "codex" }),
  chat("c3", { workspaceId: "w2", title: "Speed up the trends query", turns: 1 }),
  chat("c4", { workspaceId: "w3", title: "Review #105800", turns: 1, inboxId: "i2", linkedPr: { repo: "posthog/posthog", number: 105800 } }),
  chat("c5", { workspaceId: "w4", title: null }),
  chat("q1", { repoId: "r1", cwd: "/Users/dev/code/posthog", title: "Where is the rust hogql parser?", turns: 1 }),
  chat("q2", { repoId: "r1", cwd: "/Users/dev/code/posthog", title: "Review #68930", turns: 1, inboxId: "i1", linkedPr: { repo: "posthog/posthog", number: 68930 } }),
];
const pr = (number: number, title: string, extra: Partial<PrStatus>): PrStatus => ({
  number, title, url: `https://github.com/posthog/posthog/pull/${number}`, state: "OPEN", draft: false, ci: "passing",
  failingChecks: [], review: "review_required", unresolvedThreads: [], mergeable: "mergeable", headSha: "abc", ...extra,
});
const prs: Record<string, PrStatus> = {
  w1: pr(113394, "fix(auth): stop the login redirect loop", { ci: "failing", failingChecks: ["Backend tests", "Lint"], unresolvedThreads: ["t1", "t2"], review: "changes_requested" }),
  w2: pr(113171, "perf(trends): cache ranked breakdowns", { review: "approved" }),
  w3: pr(105800, "fix(actions): reject invalid regexes in action steps", { ci: "pending" }),
  q2: pr(68930, "fix(hogql): let comparisons bind to aliased expressions again", { mergeable: "conflicting" }),
};
const item = (id: string, number: number, title: string, extra: Partial<InboxItem>): InboxItem => ({
  id, kind: "review_request", repo: "posthog/posthog", number, title, author: "ann", url: `https://github.com/posthog/posthog/pull/${number}`,
  chatId: null, status: "new", summary: "", createdAt: now, updatedAt: new Date(now - 3600_000 * number % 90_000_000).toISOString(),
  read: true, direct: false, dismissed: false, ...extra,
});
const inbox: InboxItem[] = [
  item("i1", 68930, "fix(hogql): let comparisons bind to aliased expressions again", { direct: true, chatId: "q2", status: "done", read: false, author: "sakce", summary: "The change makes comparison operators bind to aliased expressions again. I'd approve it with one question: the new branch in `visit_alias` skips type resolution when the alias shadows a column." }),
  item("i2", 105800, "fix(actions): reject invalid regexes in action steps before ClickHouse", { chatId: "c4", status: "running", author: "flcrom" }),
  item("i3", 113716, "fix(hogql): parse operators after aliases in function arguments", { read: false, author: "zemamba" }),
  item("i4", 100089, "refactor(hogql): split literal folding helpers", { author: "pauldambra" }),
  item("i5", 18375, "docs: Add toIntOrDefault to ClickHouse functions list", { repo: "posthog/posthog.com", author: "inkeep[bot]" }),
];

const assistant = (content: unknown[], usage?: unknown): AgentEvent => ({
  type: "assistant", uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { role: "assistant", content, usage },
});
const toolResult = (id: string, content: string, isError = false, parent: string | null = null): AgentEvent => ({
  type: "user", parent_tool_use_id: parent, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
});
const result = (ms: number): AgentEvent => ({
  type: "result", subtype: "success", is_error: false, duration_ms: ms, modelUsage: { "claude-opus": { contextWindow: 1_000_000 } },
});
const transcripts: Record<string, AgentEvent[]> = {
  c1: [
    { type: "productor_user", text: "Users get stuck in a redirect loop after logging in when the `next` param is another login URL. Can you find and fix it?", attachments: ["/Users/dev/Desktop/redirect-loop.png"] },
    assistant([{ type: "thinking", thinking: "The loop probably comes from not validating `next`. Let me look at how the login view resolves the redirect target before changing anything." }]),
    assistant([{ type: "text", text: "I'll look at how the login view resolves its redirect target." }]),
    assistant([{ type: "tool_use", id: "t1", name: "Grep", input: { pattern: "def get_redirect_url", path: "posthog/" } }]),
    toolResult("t1", "posthog/views/login.py:142:    def get_redirect_url(self):\nposthog/utils/redirects.py:18:def get_redirect_url(request):"),
    assistant([{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/Users/dev/productor/workspaces/havana/posthog/views/login.py" } }]),
    toolResult("t2", "class LoginView(View):\n    ..."),
    assistant([{ type: "tool_use", id: "t3", name: "TodoWrite", input: { todos: [
      { content: "Reproduce the loop with a failing test", status: "completed" },
      { content: "Reject login URLs as redirect targets", status: "in_progress" },
      { content: "Run the auth test suite", status: "pending" },
    ] } }]),
    assistant([{ type: "tool_use", id: "t4", name: "Task", input: { description: "Find every caller of get_redirect_url" } }]),
    { ...assistant([{ type: "tool_use", id: "t4a", name: "Grep", input: { pattern: "get_redirect_url\\(" } }]), parent_tool_use_id: "t4" },
    toolResult("t4a", "3 matches", false, "t4"),
    toolResult("t4", "Three callers: LoginView, SignupView and the SSO callback."),
    assistant([{ type: "tool_use", id: "t5", name: "Edit", input: { file_path: "/Users/dev/productor/workspaces/havana/posthog/views/login.py" } }]),
    toolResult("t5", "Edited."),
    assistant([{ type: "tool_use", id: "t6", name: "Bash", input: { command: "pytest posthog/views/test/test_login.py -k redirect" } }]),
    toolResult("t6", "FAILED test_login.py::test_next_cannot_be_login - AssertionError: 302 != 200\n1 failed, 11 passed", true),
    assistant([{ type: "text", text: "The loop is fixed, with one test still failing that I need to look at.\n\n## What was wrong\n\n`get_redirect_url` accepted any same-origin path as `next`, including `/login` itself, so a logged-in user was sent straight back to the login page.\n\n```python\ndef get_redirect_url(self) -> str:\n    target = self.request.GET.get(\"next\", \"/\")\n    # A login URL as the target would loop forever.\n    if is_login_path(target):\n        return \"/\"\n    return target\n```\n\n| File | Change |\n| --- | --- |\n| `posthog/views/login.py` | Reject login paths as targets |\n| `posthog/utils/redirects.py` | New `is_login_path` helper |\n\nSee the [Django docs on redirects](https://docs.djangoproject.com/en/5.0/topics/http/shortcuts/#redirect) for the general pattern." }], { input_tokens: 4, cache_read_input_tokens: 182_000, cache_creation_input_tokens: 9_000 }),
    result(184_000),
    { type: "productor_snapshot", turn: 1, sha: "abc" },
    { type: "productor_user", text: "Nice. Fix the failing test too.", attachments: [] },
    assistant([{ type: "text", text: "The test expected the old behaviour. I updated it to assert the redirect goes to `/`, and all 12 now pass." }], { input_tokens: 2, cache_read_input_tokens: 201_000, cache_creation_input_tokens: 2_000 }),
    result(41_000),
    { type: "productor_snapshot", turn: 2, sha: "def" },
    { type: "productor_user", text: "Now push it.", attachments: [] },
    assistant([{ type: "text", text: "Committed. Pushing the branch now." }]),
  ],
  c3: [
    { type: "productor_user", text: "The trends query takes 9s on large teams. Profile it.", attachments: [] },
    assistant([{ type: "text", text: "Most of the time goes to the ranked breakdown subquery, which runs once per series." }]),
    result(62_000),
    { type: "productor_user", text: "Cache it per team.", attachments: [] },
    { type: "productor_interrupted" },
  ],
  q1: [
    { type: "productor_user", text: "Where is the rust hogql parser?", attachments: [] },
    assistant([{ type: "text", text: "The Rust HogQL parser is in `rust/hogql/parser/`. It's a crate called `hogql_parser_rs`.\n\n- `src/lex.rs` is the lexer.\n- `src/parse.rs` holds the parser itself." }]),
    result(9_000),
  ],
  q2: [
    { type: "productor_user", text: "My review has been requested on pull request #68930…", attachments: [] },
    assistant([{ type: "text", text: "I'd approve it with one question for the author about alias shadowing." }]),
    result(120_000),
  ],
  c4: [{ type: "productor_user", text: "My review has been requested on pull request #105800…", attachments: [] }],
  c2: [
    { type: "productor_user", text: "Add tests for the redirect.", attachments: [] },
    assistant([{ type: "tool_use", id: "x1", name: "Shell", input: { command: "pytest -k redirect" } }]),
    toolResult("x1", "12 passed"),
    assistant([{ type: "text", text: "Added three tests covering login, signup and the SSO callback." }]),
    { type: "result", subtype: "success", is_error: false, duration_ms: 75_000, usage: { input_tokens: 36_000 } },
  ],
  c5: [],
};

const DIFF = `diff --git a/posthog/views/login.py b/posthog/views/login.py
index 1111111..2222222 100644
--- a/posthog/views/login.py
+++ b/posthog/views/login.py
@@ -140,9 +140,13 @@ class LoginView(View):
     template_name = "login.html"
 
     def get_redirect_url(self) -> str:
-        return self.request.GET.get("next", "/")
+        target = self.request.GET.get("next", "/")
+        # A login URL as the target would loop forever.
+        if is_login_path(target):
+            return "/"
+        return target
 
     def post(self, request):
         form = LoginForm(request.POST)
diff --git a/posthog/utils/redirects.py b/posthog/utils/redirects.py
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/posthog/utils/redirects.py
@@ -0,0 +1,6 @@
+LOGIN_PATHS = ("/login", "/signup")
+
+
+def is_login_path(path: str) -> bool:
+    """Whether a redirect target would land back on a login page."""
+    return path.split("?")[0].rstrip("/") in LOGIN_PATHS
`;

const FILES = ["README.md", "package.json", "posthog/views/login.py", "posthog/views/signup.py", "posthog/utils/redirects.py", "posthog/hogql/parser.py", "frontend/src/scenes/authentication/Login.tsx", "rust/hogql/parser/src/lex.rs"];

const statuses: Record<string, string> = { c1: "awaiting_permission", c4: "running" };

/** Plays back a short canned turn so sending a message does something visible. */
function reply(chatId: string, text: string) {
  transcripts[chatId] ??= [];
  const push = (event: AgentEvent) => {
    transcripts[chatId].push(event);
    emit("agent-event", { chatId, event });
  };
  push({ type: "productor_user", text, attachments: [] });
  emit("chat-status", { chatId, status: "running" });
  const words = "This is the mock backend, so nothing was really run. It streams a reply like this one so the interface can be exercised in a browser.".split(" ");
  emit("agent-event", { chatId, event: { type: "stream_event", event: { type: "message_start" } } });
  words.forEach((word, i) =>
    setTimeout(() => emit("agent-event", { chatId, event: { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: word + " " } } } }), 60 * i),
  );
  setTimeout(() => {
    push(assistant([{ type: "text", text: words.join(" ") }], { input_tokens: 1200 }));
    push(result(2_000));
    emit("chat-status", { chatId, status: "idle" });
  }, 60 * words.length + 200);
}

const commands: Record<string, (args: Record<string, unknown>) => unknown> = {
  get_state: () => ({
    repos, workspaces, chats, statuses, prs, inbox,
    groups: [{ id: "g1", name: "Login fixes" }],
    settings: { useApiKey: false, editor: "code" },
    problems: { inbox: "GitHub: HTTP 401: Bad credentials (https://api.github.com/search/issues)" },
    claudeFastRefused: "extra usage is turned off for this account",
  }),
  get_transcript: ({ chatId }) => transcripts[chatId as string] ?? [],
  get_diff: () => ({ base: "abc", diff: DIFF, uncommitted: ["posthog/utils/redirects.py"], unpushed: 2 }),
  list_files: () => FILES,
  list_chat_files: () => FILES,
  read_file: ({ path }) => `# ${path}\n\ndef example():\n    return "mock file contents"\n`,
  agent_defaults: () => ({ claudeModel: "opus", codexModel: "gpt-6", codexFast: true }),
  search_chats: ({ query }) => [{ chatId: "c1", who: "agent", snippet: `…the loop is fixed, with one test matching “${query}”…` }],
  send_message: ({ chatId, text }) => void reply(chatId as string, text as string),
  term_open: () => {
    const id = crypto.randomUUID();
    setTimeout(() => emit("term-output", { id, data: btoa("~/productor/workspaces/havana (george/havana) $ pnpm test auth\r\n\r\n ✓ 12 passed\r\n\r\n$ ".replace(/✓/g, "ok")) }), 150);
    return id;
  },
  my_pull_requests: () => [
    { repo: "posthog/posthog", number: 113394, title: "fix(auth): stop the login redirect loop", url: "https://github.com/posthog/posthog/pull/113394", draft: false, updatedAt: new Date(now - 1800_000).toISOString() },
    { repo: "posthog/posthog", number: 112578, title: "feat(hogql): add flagged experimental query sharing", url: "https://github.com/posthog/posthog/pull/112578", draft: true, updatedAt: new Date(now - 86_400_000).toISOString() },
    { repo: "someone/elsewhere", number: 12, title: "docs: fix a typo in the readme", url: "https://github.com/someone/elsewhere/pull/12", draft: false, updatedAt: new Date(now - 4 * 86_400_000).toISOString() },
  ],
  health: () => [
    { name: "Git", ok: true, detail: "git version 2.50.1", fix: "" },
    { name: "Claude Code", ok: true, detail: "2.1.294 (Claude Code)", fix: "" },
    { name: "Codex", ok: true, detail: "Logged in using ChatGPT", fix: "" },
    { name: "GitHub CLI", ok: false, detail: "You are not logged into any GitHub hosts.", fix: "Needed for the inbox and pull requests: install gh and run `gh auth login`." },
  ],
  storage: () => [
    { workspaceId: "w1", name: "havana", path: "/Users/dev/productor/workspaces/havana", kb: 7_024_000 },
    { workspaceId: null, name: "posthog (shared read-only checkout)", path: "/Users/dev/productor/quick/posthog", kb: 6_900_000 },
    { workspaceId: "w4", name: "nairobi", path: "/Users/dev/productor/workspaces/nairobi", kb: 48_200 },
  ],
  "plugin:dialog|confirm": () => true,
  "plugin:dialog|open": () => null,
  "plugin:notification|is_permission_granted": () => true,
};

Object.assign(window, {
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
    transformCallback(callback: Handler) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    async invoke(command: string, args: Record<string, unknown> = {}) {
      if (command === "plugin:event|listen") {
        const event = args.event as string;
        listeners.set(event, [...(listeners.get(event) ?? []), args.handler as number]);
        return args.handler;
      }
      return commands[command]?.(args) ?? null;
    },
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
});

// Things only a running agent produces: something waiting on the user.
setTimeout(() => {
  emit("agent-event", { chatId: "c1", event: { type: "control_request", request_id: "p1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "git push -u origin george/havana" } } } });
  emit("agent-commands", { chatId: "c1", commands: [
    { name: "review", description: "Review the current changes" },
    { name: "code-review", description: "Review a diff or pull request for bugs" },
    { name: "simplify", description: "Clean up the changed code" },
  ] });
}, 400);

/** For scripting scenes from the browser console. */
Object.assign(window, {
  __mock: {
    emit,
    ask: (chatId: string) => emit("agent-event", { chatId, event: { type: "control_request", request_id: "q" + Date.now(), request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "Which approach should I take?", header: "Approach", multiSelect: false, options: [{ label: "Reject in the view", description: "Smallest change, one file" }, { label: "Validate in middleware", description: "Covers every entry point" }] }] } } } }),
    plan: (chatId: string) => emit("agent-event", { chatId, event: { type: "control_request", request_id: "x" + Date.now(), request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", input: { plan: "1. Add `is_login_path` to `redirects.py`.\n2. Use it in `LoginView.get_redirect_url`.\n3. Add a regression test." } } } }),
  },
});
