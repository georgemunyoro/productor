//! Tracks the agent process behind each chat. Claude Code chats keep one
//! long-lived process speaking its stream-json protocol over stdin/stdout;
//! Codex chats (see `codex.rs`) run one process per turn.

use crate::{codex, git, now_ms, AppState};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

struct AgentHandle {
    /// Distinguishes this process from an earlier one for the same chat.
    generation: String,
    stdin: mpsc::UnboundedSender<String>,
    kill: Option<oneshot::Sender<()>>,
    /// Tool inputs of permission requests waiting on the user, by request id.
    pending: HashMap<String, Value>,
    /// The process runs a single turn and takes no further input, so the
    /// only way to interrupt it is to kill it.
    one_shot: bool,
}

#[derive(Default)]
pub struct Agents {
    procs: Mutex<HashMap<String, AgentHandle>>,
    statuses: Mutex<HashMap<String, String>>,
}

impl Agents {
    pub fn statuses(&self) -> HashMap<String, String> {
        self.statuses.lock().unwrap().clone()
    }

    /// Registers a process that runs a single turn. The returned receiver
    /// fires if the turn should be abandoned; the generation identifies this
    /// registration to `unregister`.
    pub fn register_one_shot(&self, chat_id: &str) -> (String, oneshot::Receiver<()>) {
        let (stdin, _) = mpsc::unbounded_channel();
        let (kill, killed) = oneshot::channel();
        let generation = uuid::Uuid::new_v4().to_string();
        self.procs.lock().unwrap().insert(
            chat_id.to_string(),
            AgentHandle {
                generation: generation.clone(),
                stdin,
                kill: Some(kill),
                pending: HashMap::new(),
                one_shot: true,
            },
        );
        (generation, killed)
    }

    pub fn unregister(&self, chat_id: &str, generation: &str) {
        let mut procs = self.procs.lock().unwrap();
        if procs.get(chat_id).is_some_and(|h| h.generation == generation) {
            procs.remove(chat_id);
        }
    }

    pub fn stop(&self, chat_id: &str) {
        if let Some(mut handle) = self.procs.lock().unwrap().remove(chat_id) {
            if let Some(kill) = handle.kill.take() {
                let _ = kill.send(());
            }
        }
    }
}

pub(crate) fn emit_event<R: Runtime>(app: &AppHandle<R>, chat_id: &str, event: &Value) {
    let _ = app.emit("agent-event", json!({ "chatId": chat_id, "event": event }));
}

/// Persists an event to the chat's transcript and forwards it to the UI.
pub(crate) fn record<R: Runtime>(app: &AppHandle<R>, chat_id: &str, event: &Value) {
    app.state::<AppState>().store.lock().unwrap().append_event(chat_id, event);
    emit_event(app, chat_id, event);
}

pub(crate) fn set_status<R: Runtime>(app: &AppHandle<R>, chat_id: &str, status: &str) {
    app.state::<AppState>()
        .agents
        .statuses
        .lock()
        .unwrap()
        .insert(chat_id.to_string(), status.to_string());
    let _ = app.emit("chat-status", json!({ "chatId": chat_id, "status": status }));
}

const QUICK_CHAT_PROMPT: &str = "This is a read-only quick chat about the repository in the \
current directory. You can read and search files and run read-only commands, but you cannot edit \
files or run commands that change anything; such tool calls are denied. If the user wants changes \
made, tell them to promote this chat to a workspace.";

const QUICK_CHAT_DENIAL: &str = "This is a read-only quick chat. The user can promote it to a \
workspace if they want changes made.";

/// Quick chats may only use tools that cannot change anything. Claude Code
/// already runs read-only shell commands without asking, so any Bash call
/// that reaches us here is one it could not prove harmless.
fn allowed_in_quick_chat(tool: &str) -> bool {
    matches!(tool, "Read" | "Glob" | "Grep" | "WebFetch" | "WebSearch" | "ToolSearch")
}

/// Workspaces run freely inside their worktree, but anything that publishes
/// work (pushing, merging a PR) waits for the user.
fn needs_approval(tool: &str, input: &Value) -> bool {
    if tool != "Bash" {
        return false;
    }
    let command = input["command"].as_str().unwrap_or("");
    command
        .split(|c| matches!(c, ';' | '&' | '|' | '\n' | '(' | ')'))
        .any(|segment| {
            let words: Vec<&str> = segment.split_whitespace().collect();
            let has = |w: &str| words.contains(&w);
            (has("git") && has("push")) || (has("gh") && has("pr") && has("merge"))
        })
}

fn permission_response(request_id: &str, input: &Value, allow: bool) -> String {
    permission_decision(request_id, input, allow.then_some(()).ok_or("The user declined this action."))
}

fn permission_decision(request_id: &str, input: &Value, decision: Result<(), &str>) -> String {
    let response = match decision {
        Ok(()) => json!({ "behavior": "allow", "updatedInput": input }),
        Err(message) => json!({ "behavior": "deny", "message": message }),
    };
    json!({
        "type": "control_response",
        "response": { "subtype": "success", "request_id": request_id, "response": response }
    })
    .to_string()
}

/// Starts the Claude Code process for a chat. Safe to call ahead of the
/// first message to hide the startup time.
pub fn start<R: Runtime>(app: &AppHandle<R>, chat_id: &str) -> Result<mpsc::UnboundedSender<String>, String> {
    let state = app.state::<AppState>();
    let (cwd, session_id, fork, quick) = {
        let store = state.store.lock().unwrap();
        let chat = store.chat(chat_id).ok_or("chat not found")?;
        let cwd = match &chat.workspace_id {
            Some(id) => store.workspace(id).ok_or("workspace not found")?.path.clone(),
            None => chat.cwd.clone().ok_or("chat has no directory")?,
        };
        (PathBuf::from(cwd), chat.session_id.clone(), chat.fork.clone(), chat.workspace_id.is_none())
    };

    let mut cmd = Command::new("claude");
    cmd.current_dir(&cwd)
        .args([
            "-p",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--replay-user-messages",
            "--permission-prompt-tool", "stdio",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if quick {
        cmd.args([
            "--permission-mode", "default",
            "--disallowedTools", "AskUserQuestion,EnterWorktree,ExitWorktree,Edit,Write,NotebookEdit",
            "--append-system-prompt", QUICK_CHAT_PROMPT,
        ]);
    } else {
        cmd.args([
            "--permission-mode", "acceptEdits",
            "--disallowedTools", "AskUserQuestion,EnterWorktree,ExitWorktree",
        ]);
    }
    if let Some(id) = &session_id {
        cmd.args(["--resume", id]);
    } else if let Some(fork) = &fork {
        // Branch off the source conversation at the chosen message. Claude
        // Code reports the new session's id in its init event.
        cmd.args(["--resume", &fork.session_id, "--fork-session", "--resume-session-at", &fork.at_uuid]);
    }
    let mut child = cmd.spawn().map_err(|e| format!("failed to start claude: {e}"))?;

    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let (kill_tx, kill_rx) = oneshot::channel::<()>();

    tauri::async_runtime::spawn(async move {
        while let Some(line) = rx.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err()
                || stdin.write_all(b"\n").await.is_err()
                || stdin.flush().await.is_err()
            {
                break;
            }
        }
    });

    let stderr_task = tauri::async_runtime::spawn(async move {
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf).await;
        buf
    });

    let generation = uuid::Uuid::new_v4().to_string();
    let reader_generation = generation.clone();
    let reader_app = app.clone();
    let reader_chat = chat_id.to_string();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let read_all = async {
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(event) = serde_json::from_str::<Value>(&line) {
                    handle_event(&reader_app, &reader_chat, &cwd, quick, event).await;
                }
            }
        };
        let killed = tokio::select! {
            _ = read_all => false,
            _ = kill_rx => true,
        };
        if killed {
            let _ = child.kill().await;
        }
        let exit = child.wait().await.ok();

        // If the chat has since been restarted, its status and handle now
        // belong to the newer process.
        let state = reader_app.state::<AppState>();
        {
            let mut procs = state.agents.procs.lock().unwrap();
            match procs.get(&reader_chat) {
                Some(handle) if handle.generation != reader_generation => return,
                _ => procs.remove(&reader_chat),
            };
        }
        let was_busy = state
            .agents
            .statuses
            .lock()
            .unwrap()
            .get(&reader_chat)
            .is_some_and(|s| s != "idle");
        if was_busy && !killed {
            let stderr = stderr_task.await.unwrap_or_default();
            let tail: String = stderr.lines().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
            let code = exit.and_then(|s| s.code()).map_or("unknown".to_string(), |c| c.to_string());
            record(&reader_app, &reader_chat, &json!({
                "type": "productor_error",
                "message": format!("Claude Code exited unexpectedly (code {code}).\n{tail}").trim(),
                "ts": now_ms(),
            }));
        }
        set_status(&reader_app, &reader_chat, "idle");
    });

    state.agents.procs.lock().unwrap().insert(
        chat_id.to_string(),
        AgentHandle { generation, stdin: tx.clone(), kill: Some(kill_tx), pending: HashMap::new(), one_shot: false },
    );
    Ok(tx)
}

async fn handle_event<R: Runtime>(app: &AppHandle<R>, chat_id: &str, cwd: &PathBuf, quick: bool, event: Value) {
    let state = app.state::<AppState>();
    match event["type"].as_str().unwrap_or("") {
        // Token-level deltas drive the live view but are not worth persisting.
        "stream_event" => emit_event(app, chat_id, &event),
        "control_request" => {
            let request_id = event["request_id"].as_str().unwrap_or("").to_string();
            let request = &event["request"];
            if request["subtype"] != "can_use_tool" {
                return;
            }
            let input = request["input"].clone();
            let tool = request["tool_name"].as_str().unwrap_or("");
            let mut procs = state.agents.procs.lock().unwrap();
            let Some(handle) = procs.get_mut(chat_id) else { return };
            if quick {
                let decision = if allowed_in_quick_chat(tool) { Ok(()) } else { Err(QUICK_CHAT_DENIAL) };
                let _ = handle.stdin.send(permission_decision(&request_id, &input, decision));
            } else if needs_approval(tool, &input) {
                handle.pending.insert(request_id, input);
                drop(procs);
                emit_event(app, chat_id, &event);
                set_status(app, chat_id, "awaiting_permission");
            } else {
                let _ = handle.stdin.send(permission_response(&request_id, &input, true));
            }
        }
        "system" => {
            if event["subtype"] == "init" {
                if let Some(id) = event["session_id"].as_str() {
                    let mut store = state.store.lock().unwrap();
                    if let Some(chat) = store.chat_mut(chat_id) {
                        if chat.session_id.as_deref() != Some(id) {
                            chat.session_id = Some(id.to_string());
                            chat.fork = None;
                            let _ = store.save();
                        }
                    }
                }
            } else if event["subtype"] == "compact_boundary" {
                record(app, chat_id, &event);
            }
        }
        "assistant" | "user" => record(app, chat_id, &event),
        "result" => finish_turn(app, chat_id, cwd, quick, &event).await,
        _ => {}
    }
}

/// Records the end of a turn and, in a workspace, snapshots the worktree so
/// the chat can later be forked from this point with the code as it was.
/// Quick chats change nothing, so there is nothing to snapshot.
pub(crate) async fn finish_turn<R: Runtime>(app: &AppHandle<R>, chat_id: &str, cwd: &Path, quick: bool, result: &Value) {
    let state = app.state::<AppState>();
    record(app, chat_id, result);
    let turn = {
        let mut store = state.store.lock().unwrap();
        let turn = store.chat_mut(chat_id).map(|chat| {
            chat.turns += 1;
            chat.turns
        });
        let _ = store.save();
        turn
    };
    if let Some(turn) = turn.filter(|_| !quick) {
        let refname = format!("refs/productor/snapshots/{chat_id}/{turn}");
        match git::snapshot(cwd, &refname).await {
            Ok(sha) => record(app, chat_id, &json!({
                "type": "productor_snapshot",
                "turn": turn,
                "ref": refname,
                "sha": sha,
                "ts": now_ms(),
            })),
            Err(e) => eprintln!("snapshot failed for {chat_id}: {e}"),
        }
    }
    set_status(app, chat_id, "idle");
}

pub fn send_message<R: Runtime>(app: &AppHandle<R>, chat_id: &str, text: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let agent = state.store.lock().unwrap().chat(chat_id).ok_or("chat not found")?.agent.clone();
    let codex = agent == "codex";
    if codex && is_busy(app, chat_id) {
        return Err("Codex is still working on the previous message.".into());
    }
    let stdin = if codex {
        None
    } else {
        let existing = state.agents.procs.lock().unwrap().get(chat_id).map(|h| h.stdin.clone());
        Some(match existing {
            Some(stdin) => stdin,
            None => start(app, chat_id)?,
        })
    };

    let note = {
        let mut store = state.store.lock().unwrap();
        let chat = store.chat_mut(chat_id).ok_or("chat not found")?;
        if chat.title.is_none() {
            let line = text.lines().next().unwrap_or("").trim();
            chat.title = Some(line.chars().take(60).collect());
        }
        let note = chat.pending_note.take();
        let _ = store.save();
        note
    };
    record(app, chat_id, &json!({ "type": "productor_user", "text": text, "ts": now_ms() }));
    set_status(app, chat_id, "running");

    let content = match note {
        Some(note) => format!("<system-note>{note}</system-note>\n\n{text}"),
        None => text.to_string(),
    };
    match stdin {
        Some(stdin) => {
            let message = json!({ "type": "user", "message": { "role": "user", "content": content } });
            stdin.send(message.to_string()).map_err(|_| "agent is not running".to_string())
        }
        None => {
            codex::run_turn(app, chat_id, content);
            Ok(())
        }
    }
}

pub fn is_busy<R: Runtime>(app: &AppHandle<R>, chat_id: &str) -> bool {
    app.state::<AppState>().agents.statuses.lock().unwrap().get(chat_id).is_some_and(|s| s != "idle")
}

/// Adds a line to the transcript that is shown to the user but never sent to
/// the agent.
pub fn notice<R: Runtime>(app: &AppHandle<R>, chat_id: &str, text: &str) {
    record(app, chat_id, &json!({ "type": "productor_notice", "text": text, "ts": now_ms() }));
}

pub fn interrupt<R: Runtime>(app: &AppHandle<R>, chat_id: &str) {
    let state = app.state::<AppState>();
    let mut procs = state.agents.procs.lock().unwrap();
    if let Some(handle) = procs.get_mut(chat_id) {
        if handle.one_shot {
            if let Some(kill) = handle.kill.take() {
                let _ = kill.send(());
            }
            return;
        }
        // Anything waiting on approval is moot once the turn is interrupted.
        for (request_id, input) in handle.pending.drain() {
            let _ = handle.stdin.send(permission_response(&request_id, &input, false));
        }
        let request = json!({
            "type": "control_request",
            "request_id": uuid::Uuid::new_v4().to_string(),
            "request": { "subtype": "interrupt" }
        });
        let _ = handle.stdin.send(request.to_string());
    }
}

pub fn respond_permission<R: Runtime>(app: &AppHandle<R>, chat_id: &str, request_id: &str, allow: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    let still_pending = {
        let mut procs = state.agents.procs.lock().unwrap();
        let handle = procs.get_mut(chat_id).ok_or("agent is not running")?;
        let input = handle.pending.remove(request_id).ok_or("request is no longer pending")?;
        let _ = handle.stdin.send(permission_response(request_id, &input, allow));
        !handle.pending.is_empty()
    };
    if !still_pending {
        set_status(app, chat_id, "running");
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::store::{Chat, Repo, Store, Workspace};

    #[test]
    fn publishing_commands_need_approval() {
        let bash = |command: &str| needs_approval("Bash", &json!({ "command": command }));
        assert!(bash("git push origin main"));
        assert!(bash("pnpm test && git -C sub push --force"));
        assert!(bash("gh pr merge 12 --squash"));
        assert!(!bash("git status"));
        assert!(!bash("gh pr view 12"));
        assert!(!needs_approval("Edit", &json!({ "file_path": "git push" })));
    }

    pub(crate) async fn wait_for_idle<R: Runtime>(app: &AppHandle<R>, chat_id: &str) {
        for _ in 0..600 {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            let status = app.state::<AppState>().agents.statuses().get(chat_id).cloned();
            if status.as_deref() == Some("idle") {
                return;
            }
        }
        panic!("agent did not finish");
    }

    /// Drives two real Claude Code turns. Needs a logged-in `claude` on PATH:
    /// cargo test -- --ignored
    #[tokio::test]
    #[ignore]
    async fn runs_turns_and_snapshots_each_one() {
        let root = std::env::temp_dir().join(format!("productor-e2e-{}", uuid::Uuid::new_v4()));
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git::git(&repo, &["init", "-q"]).await.unwrap();
        std::fs::write(repo.join("README.md"), "hello").unwrap();
        git::git(&repo, &["add", "."]).await.unwrap();
        git::git(&repo, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]).await.unwrap();

        let mut store = Store::load(root.join("data"));
        let path = repo.to_string_lossy().to_string();
        store.data.repos.push(Repo { id: "r".into(), name: "repo".into(), path: path.clone(), run_script: None });
        store.data.workspaces.push(Workspace {
            id: "w".into(), repo_id: "r".into(), name: "w".into(), branch: "main".into(),
            path, created_at: 0, archived: false, base_sha: None, group_id: None,
        });
        let mut chat = Chat::new(Some("w".into()), None, None);
        chat.id = "c".into();
        store.data.chats.push(chat);

        let app = tauri::test::mock_app();
        app.manage(AppState {
            store: std::sync::Mutex::new(store),
            agents: Agents::default(),
            terminals: Default::default(),
        });
        let handle = app.handle().clone();

        send_message(&handle, "c", "Create a file named note.txt containing exactly the word alpha. Use the Bash tool to do it.").unwrap();
        wait_for_idle(&handle, "c").await;
        send_message(&handle, "c", "Reply with only the contents of the file you just created.").unwrap();
        wait_for_idle(&handle, "c").await;

        let state = handle.state::<AppState>();
        let events = state.store.lock().unwrap().read_events("c");
        let chat = state.store.lock().unwrap().chat("c").cloned().unwrap();
        let kinds: Vec<&str> = events.iter().filter_map(|e| e["type"].as_str()).collect();
        println!("{kinds:?}");

        assert_eq!(chat.turns, 2);
        assert!(chat.session_id.is_some());
        assert_eq!(kinds.iter().filter(|k| **k == "productor_snapshot").count(), 2);
        assert!(std::fs::read_to_string(repo.join("note.txt")).unwrap().contains("alpha"));
        let snap = git::git(&repo, &["show", "refs/productor/snapshots/c/1:note.txt"]).await.unwrap();
        assert!(snap.contains("alpha"));
        let last_text = events.iter().rev().find(|e| e["type"] == "assistant").unwrap().to_string();
        assert!(last_text.contains("alpha"), "second turn should remember the first: {last_text}");

        state.agents.stop("c");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A quick chat must not be able to change files, and promoting it must
    /// carry the conversation into the new worktree. Needs a logged-in `claude`.
    #[tokio::test]
    #[ignore]
    async fn quick_chat_is_read_only_and_survives_promotion() {
        let root = std::env::temp_dir().join(format!("productor-quick-{}", uuid::Uuid::new_v4()));
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git::git(&repo, &["init", "-q"]).await.unwrap();
        std::fs::write(repo.join("README.md"), "The code word is zebra-42.").unwrap();
        git::git(&repo, &["add", "."]).await.unwrap();
        git::git(&repo, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]).await.unwrap();

        let mut store = Store::load(root.join("data"));
        let repo_str = repo.to_string_lossy().to_string();
        store.data.repos.push(Repo { id: "r".into(), name: "repo".into(), path: repo_str.clone(), run_script: None });
        let mut chat = Chat::new(None, Some("r".into()), Some(repo_str.clone()));
        chat.id = "q".into();
        store.data.chats.push(chat);

        let app = tauri::test::mock_app();
        app.manage(AppState {
            store: std::sync::Mutex::new(store),
            agents: Agents::default(),
            terminals: Default::default(),
        });
        let handle = app.handle().clone();
        let state = handle.state::<AppState>();

        send_message(&handle, "q", "Read README.md and tell me the code word. Then run the bash command `echo hi > blocked.txt` and tell me whether it was allowed.").unwrap();
        wait_for_idle(&handle, "q").await;
        assert!(!repo.join("blocked.txt").exists(), "a quick chat wrote a file");
        let events = state.store.lock().unwrap().read_events("q");
        assert!(events.iter().any(|e| e["type"] == "assistant" && e.to_string().contains("zebra-42")));
        assert!(!events.iter().any(|e| e["type"] == "productor_snapshot"));

        // Promote by hand, as the `promote_chat` command does.
        state.agents.stop("q");
        let worktree = root.join("wt");
        let worktree_str = worktree.to_string_lossy().to_string();
        git::git(&repo, &["worktree", "add", "-q", "-b", "t/wt", &worktree_str, "HEAD"]).await.unwrap();
        let session = state.store.lock().unwrap().chat("q").unwrap().session_id.clone().unwrap();
        crate::copy_session(&session, &repo, &worktree).unwrap();
        {
            let mut store = state.store.lock().unwrap();
            store.data.workspaces.push(Workspace {
                id: "w".into(), repo_id: "r".into(), name: "wt".into(), branch: "t/wt".into(),
                path: worktree_str.clone(), created_at: 0, archived: false, base_sha: None, group_id: None,
            });
            let chat = store.chat_mut("q").unwrap();
            chat.workspace_id = Some("w".into());
            chat.repo_id = None;
            chat.cwd = None;
            chat.pending_note = Some(format!("This conversation has moved to a new git worktree at {worktree_str}. You can now edit files there."));
        }

        send_message(&handle, "q", "Without reading any files, create note.txt in the current directory containing the code word from earlier.").unwrap();
        wait_for_idle(&handle, "q").await;
        let note = std::fs::read_to_string(worktree.join("note.txt")).expect("note.txt was not created in the worktree");
        assert!(note.contains("zebra-42"), "conversation was not carried over: {note}");
        assert!(!repo.join("note.txt").exists());

        state.agents.stop("q");
        let _ = std::fs::remove_dir_all(&root);
    }
}
