//! Tracks the agent process behind each chat. Claude Code chats keep one
//! long-lived process speaking its stream-json protocol over stdin/stdout;
//! Codex chats (see `codex.rs`) run one process per turn.

use crate::{codex, git, inbox, now_ms, pr, AppState};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use base64::Engine;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

/// Why Claude Code last refused fast mode, if it did: known only once an
/// agent has started with it asked for.
static FAST_REFUSED: Mutex<Option<String>> = Mutex::new(None);

pub fn fast_refused() -> Option<String> {
    FAST_REFUSED.lock().unwrap().clone()
}

struct AgentHandle {
    /// Process id, for stopping it when the app exits.
    pid: Option<u32>,
    /// Distinguishes this process from an earlier one for the same chat.
    generation: String,
    stdin: mpsc::UnboundedSender<String>,
    kill: Option<oneshot::Sender<()>>,
    /// Requests waiting on the user, by request id: the tool and its input.
    pending: HashMap<String, (String, Value)>,
    /// When the process last started or finished a turn.
    last_used: std::time::Instant,
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
    /// Requests still waiting on the user, by chat, in the shape the UI
    /// keeps them: so a window that reloads can show them again.
    pub fn pending(&self) -> HashMap<String, Vec<Value>> {
        self.procs
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, handle)| !handle.pending.is_empty())
            .map(|(chat, handle)| {
                let requests = handle
                    .pending
                    .iter()
                    .map(|(id, (tool, input))| json!({ "requestId": id, "toolName": tool, "input": input }))
                    .collect();
                (chat.clone(), requests)
            })
            .collect()
    }

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
                pid: None,
                generation: generation.clone(),
                stdin,
                kill: Some(kill),
                pending: HashMap::new(),
                last_used: std::time::Instant::now(),
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

    /// Stops long-lived agent processes that have sat idle for `limit`. Each
    /// holds memory while it waits; the conversation resumes from its
    /// session when the next message starts a new one.
    pub fn reap_idle(&self, limit: std::time::Duration) {
        let statuses = self.statuses.lock().unwrap().clone();
        let mut procs = self.procs.lock().unwrap();
        let idle: Vec<String> = procs
            .iter()
            .filter(|(id, h)| !h.one_shot && h.last_used.elapsed() > limit && statuses.get(*id).is_none_or(|s| s == "idle"))
            .map(|(id, _)| id.clone())
            .collect();
        for id in idle {
            if let Some(mut handle) = procs.remove(&id) {
                if let Some(kill) = handle.kill.take() {
                    let _ = kill.send(());
                }
            }
        }
    }

    /// Ends every agent process at once, without waiting on the runtime.
    /// For when the app is exiting and its tasks will not get to run.
    pub fn stop_all_now(&self) {
        for (_, handle) in self.procs.lock().unwrap().drain() {
            if let Some(pid) = handle.pid {
                let _ = std::process::Command::new("kill").arg(pid.to_string()).status();
            }
        }
    }

    fn touch(&self, chat_id: &str) {
        if let Some(handle) = self.procs.lock().unwrap().get_mut(chat_id) {
            handle.last_used = std::time::Instant::now();
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
    inbox::on_status(app, chat_id, status);
}

const QUICK_CHAT_PROMPT: &str = "This is a read-only quick chat about the repository in the \
current directory. You can read and search files and run read-only commands, but you cannot edit \
files or run commands that change anything; such tool calls are denied. If the user wants changes \
made, tell them to promote this chat to a workspace.";

const QUICK_CHAT_DENIAL: &str = "This is a read-only quick chat. The user can promote it to a \
workspace if they want changes made.";

/// Shell commands a read-only chat may run even though Claude Code cannot
/// prove them harmless itself, mostly because they talk to GitHub. A command
/// qualifies only if every part of it is on the list and it cannot write
/// through redirection or substitution.
fn read_only_command(command: &str) -> bool {
    const ALLOWED: &[&[&str]] = &[
        &["gh", "pr", "view"], &["gh", "pr", "diff"], &["gh", "pr", "checks"], &["gh", "pr", "list"],
        &["gh", "pr", "status"], &["gh", "issue", "view"], &["gh", "issue", "list"], &["gh", "run", "view"],
        &["gh", "run", "list"], &["gh", "repo", "view"], &["gh", "search"], &["gh", "api"],
        &["git", "fetch"], &["git", "log"], &["git", "diff"], &["git", "show"], &["git", "status"],
        &["git", "blame"], &["git", "rev-parse"], &["git", "merge-base"],
        &["head"], &["tail"], &["grep"], &["rg"], &["wc"], &["sort"], &["uniq"], &["cat"], &["jq"], &["cut"], &["ls"],
    ];
    // `gh api` reads by default but writes when given a method or fields.
    const GH_API_WRITES: &[&str] = &["-X", "--method", "-f", "-F", "--field", "--raw-field", "--input"];

    // Discarding or merging error output writes nothing worth guarding.
    let mut command = command.to_string();
    for harmless in ["2>&1", "2>/dev/null", "2> /dev/null"] {
        command = command.replace(harmless, " ");
    }
    if [">", "`", "$(", "<("].iter().any(|s| command.contains(s)) {
        return false;
    }
    let mut segments = command
        .split(|c| matches!(c, ';' | '&' | '|' | '\n'))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .peekable();
    if segments.peek().is_none() {
        return false;
    }
    segments.all(|segment| {
        let words: Vec<&str> = segment.split_whitespace().collect();
        if words.starts_with(&["gh", "api"]) && words.iter().any(|w| GH_API_WRITES.contains(w)) {
            return false;
        }
        ALLOWED.iter().any(|prefix| words.starts_with(prefix))
    })
}

/// Read-only chats may only use tools that cannot change anything. Claude
/// Code already runs shell commands it knows to be read-only without asking,
/// so a Bash call that reaches us is one it could not vouch for.
fn allowed_in_quick_chat(tool: &str, input: &Value) -> bool {
    if matches!(tool, "Read" | "Glob" | "Grep" | "WebFetch" | "WebSearch" | "ToolSearch") {
        return true;
    }
    tool == "Bash" && read_only_command(input["command"].as_str().unwrap_or(""))
}

/// Workspaces run freely inside their worktree, but anything that reaches
/// other people (pushing, opening or merging a pull request, commenting on
/// GitHub) waits for the user.
fn needs_approval(tool: &str, input: &Value) -> bool {
    // `gh api` only reads unless it is given a method or fields to send.
    const GH_API_WRITES: &[&str] = &["-X", "--method", "-f", "-F", "--field", "--raw-field", "--input"];
    if tool != "Bash" {
        return false;
    }
    let command = input["command"].as_str().unwrap_or("");
    command
        .split(|c| matches!(c, ';' | '&' | '|' | '\n' | '(' | ')'))
        .any(|segment| {
            let words: Vec<&str> = segment.split_whitespace().collect();
            let has = |w: &str| words.contains(&w);
            let gh_pr = has("gh") && has("pr");
            (has("git") && has("push"))
                || (gh_pr && ["merge", "create", "comment", "review", "close", "ready", "edit"].iter().any(|w| has(w)))
                || (has("gh") && has("issue") && has("comment"))
                || (has("gh") && has("api") && words.iter().any(|w| GH_API_WRITES.contains(w)))
        })
}

/// Whether everything in a command that would need approval is an ordinary
/// push: no forcing, other than the lease form a rebase needs. A workspace
/// trusted to push may run these unasked.
fn only_pushes(input: &Value) -> bool {
    let command = input["command"].as_str().unwrap_or("");
    command
        .split(|c| matches!(c, ';' | '&' | '|' | '\n' | '(' | ')'))
        .filter(|segment| needs_approval("Bash", &json!({ "command": segment })))
        .all(|segment| {
            let words: Vec<&str> = segment.split_whitespace().collect();
            let forced = words.iter().any(|w| matches!(*w, "-f" | "--force" | "--delete" | "-d" | "--mirror") || w.starts_with('+'));
            words.contains(&"git") && words.contains(&"push") && !words.contains(&"gh") && !forced
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
    let (cwd, session_id, fork, quick, model, fast, plan, use_api_key) = {
        let store = state.store.lock().unwrap();
        let chat = store.chat(chat_id).ok_or("chat not found")?;
        let cwd = match &chat.workspace_id {
            Some(id) => store.workspace(id).ok_or("workspace not found")?.path.clone(),
            None => chat.cwd.clone().ok_or("chat has no directory")?,
        };
        (
            PathBuf::from(cwd),
            chat.session_id.clone(),
            chat.fork.clone(),
            chat.workspace_id.is_none(),
            chat.model.clone(),
            chat.fast,
            chat.plan,
            store.data.settings.use_api_key,
        )
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
    // Run this way, Claude Code bills an API key in the environment in
    // preference to the user's subscription login. Productor runs on the
    // subscription however it was launched, unless told otherwise, so a key
    // picked up from the shell is kept away from the agent.
    if !use_api_key {
        cmd.env_remove("ANTHROPIC_API_KEY").env_remove("ANTHROPIC_AUTH_TOKEN");
    }
    if quick {
        cmd.args([
            "--permission-mode", "default",
            "--disallowedTools", "EnterWorktree,ExitWorktree,Edit,Write,NotebookEdit",
            "--append-system-prompt", QUICK_CHAT_PROMPT,
        ]);
    } else {
        cmd.args([
            "--permission-mode", if plan { "plan" } else { "acceptEdits" },
            "--disallowedTools", "EnterWorktree,ExitWorktree",
        ]);
    }
    if let Some(model) = &model {
        cmd.args(["--model", model]);
    }
    // Run this way, Claude Code only uses fast mode if asked to; there is no
    // flag for it, so it goes in as a setting.
    if fast == Some(true) {
        cmd.args(["--settings", r#"{"fastMode":true}"#]);
    }
    if let Some(id) = &session_id {
        cmd.args(["--resume", id]);
    } else if let Some(fork) = &fork {
        // Branch off the source conversation at the chosen message. Claude
        // Code reports the new session's id in its init event.
        cmd.args(["--resume", &fork.session_id, "--fork-session", "--resume-session-at", &fork.at_uuid]);
    }
    let mut child = cmd.spawn().map_err(|e| format!("failed to start claude: {e}"))?;

    let pid = child.id();
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
                    handle_event(&reader_app, &reader_chat, &cwd, quick, fast == Some(true), event).await;
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
        AgentHandle {
            pid,
            generation,
            stdin: tx.clone(),
            kill: Some(kill_tx),
            pending: HashMap::new(),
            last_used: std::time::Instant::now(),
            one_shot: false,
        },
    );
    Ok(tx)
}

async fn handle_event<R: Runtime>(
    app: &AppHandle<R>,
    chat_id: &str,
    cwd: &PathBuf,
    quick: bool,
    wants_fast: bool,
    event: Value,
) {
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
            let trusted_to_push = {
                let store = state.store.lock().unwrap();
                store
                    .chat(chat_id)
                    .and_then(|c| c.workspace_id.as_deref())
                    .and_then(|id| store.workspace(id))
                    .is_some_and(|w| w.auto_push)
            };
            let mut procs = state.agents.procs.lock().unwrap();
            let Some(handle) = procs.get_mut(chat_id) else { return };
            // A question for the user, or a plan put up for approval, is
            // theirs to answer in any kind of chat.
            let for_the_user = matches!(tool, "AskUserQuestion" | "ExitPlanMode");
            if quick && !for_the_user {
                let allowed = allowed_in_quick_chat(tool, &input);
                let decision = if allowed { Ok(()) } else { Err(QUICK_CHAT_DENIAL) };
                let _ = handle.stdin.send(permission_decision(&request_id, &input, decision));
            } else if for_the_user || (needs_approval(tool, &input) && !(trusted_to_push && only_pushes(&input))) {
                handle.pending.insert(request_id, (tool.to_string(), input));
                drop(procs);
                emit_event(app, chat_id, &event);
                set_status(app, chat_id, "awaiting_permission");
            } else {
                let _ = handle.stdin.send(permission_response(&request_id, &input, true));
            }
        }
        "system" => {
            if event["subtype"] == "init" {
                // Fast mode can be refused, for instance by the account's
                // plan. Say so rather than letting the toggle silently lie.
                if wants_fast && event["fast_mode_state"].as_str().is_some_and(|s| s != "on") {
                    let why = match event["fast_mode_disabled_reason"].as_str().unwrap_or("") {
                        "extra_usage_disabled" => "extra usage is turned off for this account".to_string(),
                        "" => "Claude Code did not say why".to_string(),
                        other => other.replace('_', " "),
                    };
                    // Say it in a chat only the first time; after that the
                    // picker shows why the option is unavailable.
                    let first = FAST_REFUSED.lock().unwrap().replace(why.clone()).is_none();
                    if first {
                        notice(app, chat_id, &format!("Fast mode is not available: {why}. Running at normal speed."));
                    }
                    let mut store = state.store.lock().unwrap();
                    if let Some(chat) = store.chat_mut(chat_id) {
                        chat.fast = None;
                        let _ = store.save();
                    }
                }
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
            } else if event["subtype"] == "commands_changed" {
                // The slash commands this agent accepts, for the composer.
                let commands: Vec<Value> = event["commands"]
                    .as_array()
                    .map(|all| all.iter().map(|c| json!({ "name": c["name"], "description": c["description"] })).collect())
                    .unwrap_or_default();
                let _ = app.emit("agent-commands", json!({ "chatId": chat_id, "commands": commands }));
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
    state.agents.touch(chat_id);
    inbox::on_turn_finished(app, chat_id, result);
    pr::on_turn_finished(app, chat_id);
    set_status(app, chat_id, "idle");
}

pub fn send_message<R: Runtime>(app: &AppHandle<R>, chat_id: &str, text: &str) -> Result<(), String> {
    send_message_with(app, chat_id, text, &[])
}

fn image_type(path: &str) -> Option<&'static str> {
    match Path::new(path).extension()?.to_str()?.to_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// Sends a message with files attached. Images are shown to the agent
/// directly; any other file is named so the agent can read it itself.
pub fn send_message_with<R: Runtime>(app: &AppHandle<R>, chat_id: &str, text: &str, attachments: &[String]) -> Result<(), String> {
    let state = app.state::<AppState>();
    let agent = state.store.lock().unwrap().chat(chat_id).ok_or("chat not found")?.agent.clone();
    let codex = agent == "codex";
    if codex && is_busy(app, chat_id) {
        return Err("Codex is still working on the previous message.".into());
    }
    let (images, files): (Vec<&String>, Vec<&String>) = attachments.iter().partition(|p| image_type(p).is_some());
    // Read the images before committing to anything, so a missing file is
    // an error up front rather than half a message.
    let mut image_blocks = Vec::new();
    if !codex {
        for path in &images {
            let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
            image_blocks.push(json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": image_type(path),
                    "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                },
            }));
        }
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
            let title: String = if line.is_empty() { "Attachment".into() } else { line.chars().take(60).collect() };
            chat.title = Some(title);
        }
        let note = chat.pending_note.take();
        let _ = store.save();
        note
    };
    record(app, chat_id, &json!({ "type": "productor_user", "text": text, "attachments": attachments, "ts": now_ms() }));
    state.agents.touch(chat_id);
    set_status(app, chat_id, "running");

    let mut content = match note {
        Some(note) => format!("<system-note>{note}</system-note>\n\n{text}"),
        None => text.to_string(),
    };
    if !files.is_empty() {
        let list: Vec<String> = files.iter().map(|p| format!("- {p}")).collect();
        content = format!("{content}\n\nAttached files (read them as needed):\n{}", list.join("\n"));
    }
    match stdin {
        Some(stdin) => {
            let body = if image_blocks.is_empty() {
                json!(content)
            } else {
                let mut blocks = vec![json!({ "type": "text", "text": content })];
                blocks.extend(image_blocks);
                json!(blocks)
            };
            let message = json!({ "type": "user", "message": { "role": "user", "content": body } });
            stdin.send(message.to_string()).map_err(|_| "agent is not running".to_string())
        }
        None => {
            codex::run_turn(app, chat_id, content, images.into_iter().cloned().collect());
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
        for (request_id, (_, input)) in handle.pending.drain() {
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
    answer(app, chat_id, request_id, allow, None)
}

/// Answers a question the agent asked with `AskUserQuestion`: one answer
/// per question, keyed by the question's text.
pub fn answer_question<R: Runtime>(app: &AppHandle<R>, chat_id: &str, request_id: &str, answers: Value) -> Result<(), String> {
    answer(app, chat_id, request_id, true, Some(answers))
}

fn answer<R: Runtime>(app: &AppHandle<R>, chat_id: &str, request_id: &str, allow: bool, answers: Option<Value>) -> Result<(), String> {
    let state = app.state::<AppState>();
    let (tool, still_pending) = {
        let mut procs = state.agents.procs.lock().unwrap();
        let handle = procs.get_mut(chat_id).ok_or("agent is not running")?;
        let (tool, mut input) = handle.pending.remove(request_id).ok_or("request is no longer pending")?;
        if let Some(answers) = answers {
            input["answers"] = answers;
        }
        let _ = handle.stdin.send(permission_response(request_id, &input, allow));
        (tool, !handle.pending.is_empty())
    };
    // Approving a plan ends plan mode for the chat, not just for this run.
    if allow && tool == "ExitPlanMode" {
        let mut store = state.store.lock().unwrap();
        if let Some(chat) = store.chat_mut(chat_id) {
            chat.plan = false;
            let _ = store.save();
        }
    }
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
        assert!(bash("gh pr create --fill"));
        assert!(bash("gh pr comment 12 --body hi"));
        assert!(bash("gh pr review 12 --approve"));
        assert!(bash("gh api repos/o/r/pulls/12/comments -f body=hi"));
        assert!(!bash("gh api repos/o/r/pulls/12/comments"));
        assert!(!bash("gh pr checks 12 && gh run view 5 --log-failed"));

        // What a workspace trusted to push may do unasked.
        let plain = |command: &str| only_pushes(&json!({ "command": command }));
        assert!(plain("git push"));
        assert!(plain("pnpm test && git push -u origin george/havana"));
        assert!(plain("git push --force-with-lease origin HEAD:fix-login"));
        assert!(!plain("git push --force"));
        assert!(!plain("git push origin +main"));
        assert!(!plain("git push origin --delete old"));
        assert!(!plain("git push && gh pr merge 12"));
        assert!(!plain("gh pr comment 12 --body done"));
        assert!(!needs_approval("Edit", &json!({ "file_path": "git push" })));
    }

    #[test]
    fn read_only_chats_may_only_run_commands_that_read() {
        assert!(read_only_command("gh pr diff 12"));
        assert!(read_only_command("gh pr view 12 --json title,body | jq .title"));
        assert!(read_only_command("git fetch origin && git log --oneline -5 origin/main"));
        assert!(read_only_command("gh api repos/o/r/pulls/12/comments"));
        assert!(read_only_command("git fetch origin pull/12/head 2>&1 | tail -3"));
        assert!(read_only_command("gh pr view 12 2>/dev/null"));
        assert!(!read_only_command("gh pr view 12 2>&1 > out.txt"));
        assert!(!read_only_command("gh api repos/o/r/issues/1/comments -f body=hi"));
        assert!(!read_only_command("gh pr merge 12"));
        assert!(!read_only_command("gh pr diff 12 > /tmp/x"));
        assert!(!read_only_command("git log; rm -rf ."));
        assert!(!read_only_command("cat $(gh pr merge 12)"));
        assert!(!read_only_command(""));

        assert!(allowed_in_quick_chat("Bash", &json!({ "command": "gh pr diff 12" })));
        assert!(!allowed_in_quick_chat("mcp__slack__send_message", &json!({})));
        assert!(!allowed_in_quick_chat("Edit", &json!({})));
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
        git::git(&repo, &["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "init"]).await.unwrap();

        let mut store = Store::load(root.join("data"));
        let path = repo.to_string_lossy().to_string();
        store.data.repos.push(Repo { id: "r".into(), name: "repo".into(), path: path.clone(), run_script: None, setup_script: None });
        store.data.workspaces.push(Workspace {
            id: "w".into(), repo_id: "r".into(), name: "w".into(), branch: "main".into(),
            path, created_at: 0, archived: false, base_sha: None, group_id: None,
            auto_pr: false, ci_fix_sha: None, ci_fix_attempts: 0, handled_threads: vec![], linked_pr: None, auto_push: false, conflict_sha: None,
        });
        let mut chat = Chat::new(Some("w".into()), None, None);
        chat.id = "c".into();
        store.data.chats.push(chat);

        let app = tauri::test::mock_app();
        app.manage(AppState {
            store: std::sync::Mutex::new(store),
            agents: Agents::default(),
            terminals: Default::default(),
            prs: Default::default(),
            problems: Default::default(),
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
        git::git(&repo, &["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "init"]).await.unwrap();

        let mut store = Store::load(root.join("data"));
        let repo_str = repo.to_string_lossy().to_string();
        store.data.repos.push(Repo { id: "r".into(), name: "repo".into(), path: repo_str.clone(), run_script: None, setup_script: None });
        let mut chat = Chat::new(None, Some("r".into()), Some(repo_str.clone()));
        chat.id = "q".into();
        store.data.chats.push(chat);

        let app = tauri::test::mock_app();
        app.manage(AppState {
            store: std::sync::Mutex::new(store),
            agents: Agents::default(),
            terminals: Default::default(),
            prs: Default::default(),
            problems: Default::default(),
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
            auto_pr: false, ci_fix_sha: None, ci_fix_attempts: 0, handled_threads: vec![], linked_pr: None, auto_push: false, conflict_sha: None,
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

    /// A chat runs on the model it was given, says so when fast mode is
    /// refused, and keeps its conversation when the model changes between
    /// turns. Needs a logged-in `claude`.
    #[tokio::test]
    #[ignore]
    async fn runs_the_chosen_model_and_switches_between_turns() {
        let root = std::env::temp_dir().join(format!("productor-model-{}", uuid::Uuid::new_v4()));
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git::git(&repo, &["init", "-q"]).await.unwrap();

        let mut store = Store::load(root.join("data"));
        let mut chat = Chat::new(None, Some("r".into()), Some(repo.to_string_lossy().to_string()));
        chat.id = "m".into();
        chat.model = Some("haiku".into());
        chat.fast = Some(true);
        store.data.chats.push(chat);

        let app = tauri::test::mock_app();
        app.manage(AppState {
            store: std::sync::Mutex::new(store),
            agents: Agents::default(),
            terminals: Default::default(),
            prs: Default::default(),
            problems: Default::default(),
        });
        let handle = app.handle().clone();
        let state = handle.state::<AppState>();
        let model_of_last_reply = |state: &AppState| {
            let events = state.store.lock().unwrap().read_events("m");
            let reply = events.iter().rev().find(|e| e["type"] == "assistant").cloned().unwrap();
            (reply["message"]["model"].as_str().unwrap_or("").to_string(), reply.to_string())
        };

        send_message(&handle, "m", "Remember the code word delta-9. Reply with just: ok").unwrap();
        wait_for_idle(&handle, "m").await;
        let (model, _) = model_of_last_reply(&state);
        assert!(model.contains("haiku"), "ran on {model}");
        let events = state.store.lock().unwrap().read_events("m");
        let notices: Vec<String> = events.iter().filter(|e| e["type"] == "productor_notice").map(|e| e["text"].to_string()).collect();
        println!("notices: {notices:?}");

        // What `set_chat_options` does: record the choice and retire the process.
        {
            let mut store = state.store.lock().unwrap();
            let chat = store.chat_mut("m").unwrap();
            chat.model = Some("sonnet".into());
            chat.fast = None;
        }
        state.agents.stop("m");
        send_message(&handle, "m", "Reply with only the code word I told you.").unwrap();
        wait_for_idle(&handle, "m").await;
        let (model, reply) = model_of_last_reply(&state);
        assert!(model.contains("sonnet"), "ran on {model}");
        assert!(reply.contains("delta-9"), "the conversation was lost when the model changed: {reply}");

        state.agents.stop("m");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The agent asks the user a question, the answer goes back, and the
    /// agent acts on it; an attached image reaches it too. Needs `claude`.
    #[tokio::test]
    #[ignore]
    async fn answers_a_question_and_sends_an_image() {
        let root = std::env::temp_dir().join(format!("productor-ask-{}", uuid::Uuid::new_v4()));
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git::git(&repo, &["init", "-q"]).await.unwrap();
        // An 8x8 solid red PNG.
        let red = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC")
            .unwrap();
        let image = root.join("shot.png");
        std::fs::write(&image, red).unwrap();

        let mut store = Store::load(root.join("data"));
        let mut chat = Chat::new(None, Some("r".into()), Some(repo.to_string_lossy().to_string()));
        chat.id = "q".into();
        chat.model = Some("haiku".into());
        store.data.chats.push(chat);
        let app = tauri::test::mock_app();
        app.manage(AppState {
            store: std::sync::Mutex::new(store),
            agents: Agents::default(),
            terminals: Default::default(),
            prs: Default::default(),
            problems: Default::default(),
        });
        let handle = app.handle().clone();
        let state = handle.state::<AppState>();

        send_message(&handle, "q", "Use the AskUserQuestion tool to ask me whether I prefer tea or coffee. Then reply with exactly: you chose <my answer>.").unwrap();
        let mut request = None;
        for _ in 0..300 {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            let procs = state.agents.procs.lock().unwrap();
            request = procs.get("q").and_then(|h| h.pending.iter().next().map(|(id, (tool, input))| (id.clone(), tool.clone(), input.clone())));
            if request.is_some() {
                break;
            }
        }
        let (request_id, tool, input) = request.expect("the question never arrived");
        assert_eq!(tool, "AskUserQuestion");
        assert_eq!(state.agents.statuses().get("q").map(String::as_str), Some("awaiting_permission"));
        let question = input["questions"][0]["question"].as_str().unwrap().to_string();
        answer_question(&handle, "q", &request_id, json!({ question: "Oolong" })).unwrap();
        wait_for_idle(&handle, "q").await;
        let reply = state.store.lock().unwrap().read_events("q").iter().rev().find(|e| e["type"] == "assistant").unwrap().to_string();
        assert!(reply.to_lowercase().contains("oolong"), "the answer did not reach the agent: {reply}");

        let attachment = image.to_string_lossy().to_string();
        send_message_with(&handle, "q", "What single colour fills the attached image? One word.", &[attachment.clone()]).unwrap();
        wait_for_idle(&handle, "q").await;
        let events = state.store.lock().unwrap().read_events("q");
        let reply = events.iter().rev().find(|e| e["type"] == "assistant").unwrap().to_string();
        assert!(reply.to_lowercase().contains("red"), "the image did not reach the agent: {reply}");
        let sent = events.iter().rev().find(|e| e["type"] == "productor_user").unwrap();
        assert_eq!(sent["attachments"][0], attachment);

        state.agents.stop("q");
        let _ = std::fs::remove_dir_all(&root);
    }
}
