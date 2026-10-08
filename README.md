# Productor

A macOS app for running coding agents (Claude Code and Codex) in parallel,
each in its own git worktree. Built with Tauri and React.

## What it does

- **Workspaces.** Each is a worktree on its own branch, with agent chats, a
  diff you can comment on, a file editor and terminals.
- **Quick chats.** Read-only questions about a repository, with no worktree.
  Promote one to a workspace if it turns into real work.
- **Forking.** Continue from the end of any turn in a new chat, or in a new
  workspace holding the code as it was at that point.
- **Groups.** Collect workspaces, send one prompt to all of them, merge their
  ready pull requests together.
- **Inbox.** Pull requests waiting for your review, each with a one-click
  agent review; and your own open pull requests, which you can open as
  workspaces.
- **Pull request care.** A workspace shows its pull request's CI, review and
  merge state. Its agent can fix CI, resolve conflicts and respond to review
  comments, on request or automatically.

## Requirements

- macOS, with `git`
- [Claude Code](https://claude.com/claude-code) logged in (`claude`), and
  optionally Codex (`codex`)
- The [GitHub CLI](https://cli.github.com) logged in (`gh auth login`), for
  the inbox and pull requests

Settings → Health shows whether each of these is ready.

## Develop

```sh
pnpm install
pnpm tauri dev      # the app, rebuilding as you edit
pnpm dev            # the interface alone in a browser, on a mock backend
```

The second is for working on the interface: open the printed URL in a
browser and it runs against fixture data in `src/dev/mock.ts`.

## Test

```sh
pnpm test                       # interface logic (needs bun)
cd src-tauri && cargo test      # backend
cargo test -- --ignored         # also the tests that drive real agents
```

The ignored tests start real Claude Code and Codex turns and need both
logged in.

## Build and install

```sh
pnpm tauri build
cp -R src-tauri/target/release/bundle/macos/Productor.app /Applications/
```

## Where things live

- `src/`: the interface. `store.ts` holds app state, `ui.ts` and
  `panelStore.ts` hold view state, `components/` the screens.
- `src-tauri/src/`: the backend. `agent.rs` runs Claude Code, `codex.rs`
  runs Codex, `pr.rs` and `inbox.rs` talk to GitHub through `gh`, `fork.rs`
  forks chats, `store.rs` persists state.
- App data: `~/Library/Application Support/dev.munyoro.productor/`.
- Worktrees: `~/productor/workspaces/<repository>/<name>`.
