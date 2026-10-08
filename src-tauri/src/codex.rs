//! Runs Codex chats. `codex exec --json` handles one turn per process and
//! takes no input while it runs, so each message starts a new process that
//! resumes the chat's thread. Its events are translated into the same shape
//! Claude Code emits, so transcripts look alike whichever agent wrote them.
//!
//! Codex cannot ask for approval in this mode, and its sandbox blocks the
//! network, commit signing and a worktree's git data. So workspace chats run
//! with approvals and sandbox off ("yolo"): nothing confines them to the
//! worktree and a push goes through unasked. Quick chats stay read-only.

use crate::agent::{finish_turn, record, set_status};
use crate::{now_ms, AppState};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Manager, Runtime};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

/// Codex wraps every command in a login shell; show just the command.
fn display_command(command: &str) -> String {
    for prefix in ["/bin/zsh -lc ", "/bin/bash -lc ", "zsh -lc ", "bash -lc "] {
        if let Some(rest) = command.strip_prefix(prefix) {
            let unquoted = rest
                .strip_prefix('"')
                .and_then(|r| r.strip_suffix('"'))
                .map(|r| r.replace("\\\"", "\"").replace("\\\\", "\\"))
                .or_else(|| rest.strip_prefix('\'').and_then(|r| r.strip_suffix('\'')).map(String::from));
            return unquoted.unwrap_or_else(|| rest.to_string());
        }
    }
    command.to_string()
}

fn assistant(content: Value) -> Value {
    json!({
        "type": "assistant",
        "uuid": uuid::Uuid::new_v4().to_string(),
        "parent_tool_use_id": null,
        "message": { "role": "assistant", "content": [content] },
    })
}

fn tool_use(id: &str, name: &str, input: Value) -> Value {
    assistant(json!({ "type": "tool_use", "id": id, "name": name, "input": input }))
}

fn tool_result(id: &str, content: &str, is_error: bool) -> Value {
    json!({
        "type": "user",
        "parent_tool_use_id": null,
        "message": {
            "role": "user",
            "content": [{ "type": "tool_result", "tool_use_id": id, "content": content, "is_error": is_error }],
        },
    })
}

/// Converts one Codex event into zero or more transcript events. `turn_id`
/// keeps tool ids unique, since Codex numbers items from zero every turn;
/// `started` remembers which tool calls have already been announced.
fn translate(event: &Value, turn_id: &str, started: &mut HashSet<String>) -> Vec<Value> {
    let kind = event["type"].as_str().unwrap_or("");
    if kind != "item.started" && kind != "item.completed" {
        return Vec::new();
    }
    let done = kind == "item.completed";
    let item = &event["item"];
    let id = format!("{turn_id}:{}", item["id"].as_str().unwrap_or(""));
    let mut out = Vec::new();
    let mut announce = |out: &mut Vec<Value>, name: &str, input: Value| {
        if started.insert(id.clone()) {
            out.push(tool_use(&id, name, input));
        }
    };

    match item["type"].as_str().unwrap_or("") {
        "agent_message" if done => {
            let text = item["text"].as_str().unwrap_or("");
            if !text.trim().is_empty() {
                out.push(assistant(json!({ "type": "text", "text": text })));
            }
        }
        "command_execution" => {
            let command = display_command(item["command"].as_str().unwrap_or(""));
            announce(&mut out, "Shell", json!({ "command": command }));
            if done {
                let failed = item["exit_code"].as_i64().is_some_and(|c| c != 0) || item["status"] == "failed";
                out.push(tool_result(&id, item["aggregated_output"].as_str().unwrap_or(""), failed));
            }
        }
        "file_change" if done => {
            let changes = item["changes"].as_array().cloned().unwrap_or_default();
            let summary: Vec<String> = changes
                .iter()
                .map(|c| format!("{} {}", c["kind"].as_str().unwrap_or("update"), c["path"].as_str().unwrap_or("")))
                .collect();
            let first = changes.first().and_then(|c| c["path"].as_str()).unwrap_or("");
            announce(&mut out, "Edit", json!({ "file_path": first, "changes": changes }));
            out.push(tool_result(&id, &summary.join("\n"), item["status"] == "failed"));
        }
        "mcp_tool_call" => {
            let name = format!(
                "{}.{}",
                item["server"].as_str().unwrap_or("mcp"),
                item["tool"].as_str().unwrap_or("tool")
            );
            announce(&mut out, &name, item["arguments"].clone());
            if done {
                let error = item["error"]["message"].as_str();
                let text = error.map(String::from).unwrap_or_else(|| item["result"].to_string());
                out.push(tool_result(&id, &text, error.is_some() || item["status"] == "failed"));
            }
        }
        "web_search" if done => {
            announce(&mut out, "WebSearch", json!({ "query": item["query"] }));
            out.push(tool_result(&id, "", false));
        }
        "error" if done => {
            out.push(json!({
                "type": "productor_notice",
                "text": item["message"].as_str().unwrap_or("Codex reported an error"),
                "ts": now_ms(),
            }));
        }
        _ => {}
    }
    out
}

/// Flags for the chat's chosen model and speed. Anything left unset falls
/// back to the user's own Codex configuration.
fn model_args(model: Option<&str>, fast: Option<bool>) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(model) = model {
        args.extend(["-m".to_string(), model.to_string()]);
    }
    match fast {
        Some(true) => args.extend(["--enable", "fast_mode", "-c", "service_tier=\"fast\""].map(String::from)),
        Some(false) => args.extend(["--disable", "fast_mode"].map(String::from)),
        None => {}
    }
    args
}

/// Flags setting what Codex may touch in this chat.
fn permission_args(quick: bool) -> Vec<&'static str> {
    if quick {
        vec!["-c", "sandbox_mode=\"read-only\""]
    } else {
        vec!["--dangerously-bypass-approvals-and-sandbox"]
    }
}

/// Runs one Codex turn in the background, recording its events as it goes.
pub fn run_turn<R: Runtime>(app: &AppHandle<R>, chat_id: &str, prompt: String, images: Vec<String>) {
    let state = app.state::<AppState>();
    let (generation, killed) = state.agents.register_one_shot(chat_id);
    let app = app.clone();
    let chat_id = chat_id.to_string();

    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let context = {
            let store = state.store.lock().unwrap();
            store.chat(&chat_id).and_then(|chat| {
                let cwd = match &chat.workspace_id {
                    Some(id) => store.workspace(id).map(|ws| ws.path.clone()),
                    None => chat.cwd.clone(),
                }?;
                let mut options = model_args(chat.model.as_deref(), chat.fast);
                for image in &images {
                    options.extend(["-i".to_string(), image.clone()]);
                }
                Some((PathBuf::from(cwd), chat.session_id.clone(), chat.workspace_id.is_none(), options))
            })
        };
        let Some((cwd, thread_id, quick, options)) = context else {
            state.agents.unregister(&chat_id, &generation);
            set_status(&app, &chat_id, "idle");
            return;
        };

        let started = std::time::Instant::now();
        let outcome = tokio::select! {
            outcome = exec(&app, &chat_id, &cwd, thread_id, quick, &options, &prompt) => outcome,
            _ = killed => Err("interrupted".to_string()),
        };
        state.agents.unregister(&chat_id, &generation);

        let duration_ms = started.elapsed().as_millis() as u64;
        let mut result = match outcome {
            Ok(usage) => json!({ "type": "result", "subtype": "success", "is_error": false, "usage": usage }),
            // Rendered as a plain "Stopped", like an interrupted Claude turn.
            Err(e) if e == "interrupted" => {
                json!({ "type": "result", "subtype": "error_during_execution", "is_error": true })
            }
            Err(e) => json!({ "type": "result", "subtype": "error", "is_error": true, "result": e }),
        };
        result["duration_ms"] = json!(duration_ms);
        finish_turn(&app, &chat_id, &cwd, quick, &result).await;
    });
}

/// Spawns `codex exec` for one turn and feeds its events to the transcript.
/// Dropping the returned future kills the process.
async fn exec<R: Runtime>(
    app: &AppHandle<R>,
    chat_id: &str,
    cwd: &Path,
    thread_id: Option<String>,
    quick: bool,
    options: &[String],
    prompt: &str,
) -> Result<Value, String> {
    let mut cmd = Command::new("codex");
    cmd.current_dir(cwd).arg("exec");
    if let Some(id) = &thread_id {
        cmd.args(["resume", id]);
    }
    cmd.args(["--json", "--skip-git-repo-check"])
        .args(permission_args(quick))
        .args(options)
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("Could not start Codex: {e}"))?;

    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(prompt.as_bytes()).await.map_err(|e| e.to_string())?;
    drop(stdin);

    let mut stderr = child.stderr.take().unwrap();
    let stderr_task = tauri::async_runtime::spawn(async move {
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf).await;
        buf
    });

    let turn_id = uuid::Uuid::new_v4().to_string();
    let mut started = HashSet::new();
    let mut failure: Option<String> = None;
    let mut completed: Option<Value> = None;
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(event) = serde_json::from_str::<Value>(&line) else { continue };
        match event["type"].as_str().unwrap_or("") {
            "thread.started" => {
                if let Some(id) = event["thread_id"].as_str() {
                    let state = app.state::<AppState>();
                    let mut store = state.store.lock().unwrap();
                    if let Some(chat) = store.chat_mut(chat_id) {
                        if chat.session_id.as_deref() != Some(id) {
                            chat.session_id = Some(id.to_string());
                            let _ = store.save();
                        }
                    }
                }
            }
            "turn.completed" => completed = Some(event["usage"].clone()),
            "turn.failed" => failure = event["error"]["message"].as_str().map(String::from),
            "error" => failure = event["message"].as_str().map(String::from),
            _ => {
                for translated in translate(&event, &turn_id, &mut started) {
                    record(app, chat_id, &translated);
                }
            }
        }
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;
    if let Some(usage) = completed {
        return Ok(usage);
    }
    if let Some(message) = failure {
        return Err(message);
    }
    let stderr = stderr_task.await.unwrap_or_default();
    // Codex logs unrelated warnings to stderr; the last lines are the most
    // likely to say why it stopped.
    let tail: Vec<&str> = stderr.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect();
    Err(format!("Codex exited without finishing the turn ({status}).\n{}", tail.join("\n")).trim().to_string())
}

/// Forks a whole Codex thread and returns the new thread's id. No turn runs.
pub async fn fork_thread(thread_id: &str, cwd: &Path) -> Result<String, String> {
    let output = Command::new("codex")
        .current_dir(cwd)
        .args(["exec", "fork", thread_id, "--json", "--skip-git-repo-check"])
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("Could not start Codex: {e}"))?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|event| event["type"] == "thread.started")
        .and_then(|event| event["thread_id"].as_str().map(String::from))
        .ok_or_else(|| "Codex did not report a forked thread.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git;
    use crate::agent::{send_message, tests::wait_for_idle, Agents};
    use crate::fork::fork_chat;
    use crate::store::{Chat, Repo, Store, Workspace};

    #[test]
    fn shows_the_command_without_its_shell_wrapper() {
        assert_eq!(display_command("/bin/zsh -lc ls"), "ls");
        assert_eq!(display_command("/bin/zsh -lc \"printf 'a\\\\n' > x.txt\""), "printf 'a\\n' > x.txt");
        assert_eq!(display_command("bash -lc 'git status'"), "git status");
        assert_eq!(display_command("git status"), "git status");
    }

    #[test]
    fn passes_the_chosen_model_and_speed() {
        assert!(model_args(None, None).is_empty(), "unset choices are left to Codex's own config");
        assert_eq!(model_args(Some("gpt-x"), Some(false)), ["-m", "gpt-x", "--disable", "fast_mode"]);
        assert_eq!(model_args(None, Some(true)), ["--enable", "fast_mode", "-c", "service_tier=\"fast\""]);
    }

    #[test]
    fn translates_a_command_into_one_tool_call_and_its_result() {
        let mut started = HashSet::new();
        let begin = json!({"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc ls","status":"in_progress"}});
        let end = json!({"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc ls","aggregated_output":"README.md\n","exit_code":1,"status":"failed"}});
        let first = translate(&begin, "t", &mut started);
        let second = translate(&end, "t", &mut started);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0]["message"]["content"][0]["input"]["command"], "ls");
        assert_eq!(second.len(), 1, "the call must not be announced twice");
        let result = &second[0]["message"]["content"][0];
        assert_eq!(result["tool_use_id"], first[0]["message"]["content"][0]["id"]);
        assert_eq!(result["is_error"], true);

        let message = json!({"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Done."}});
        assert_eq!(translate(&message, "t", &mut started)[0]["message"]["content"][0]["text"], "Done.");
    }

    /// Drives real Codex turns: a workspace chat that writes and commits, a
    /// second turn that resumes the thread, and a fork into a new worktree.
    /// Needs a logged-in `codex`: cargo test codex -- --ignored
    #[tokio::test]
    #[ignore]
    async fn runs_resumes_and_forks_a_codex_chat() {
        let root = std::env::temp_dir().join(format!("productor-codex-{}", uuid::Uuid::new_v4()));
        std::env::set_var("PRODUCTOR_HOME", root.join("home"));
        let main = root.join("main");
        std::fs::create_dir_all(&main).unwrap();
        git::git(&main, &["init", "-q"]).await.unwrap();
        std::fs::write(main.join("README.md"), "hello").unwrap();
        git::git(&main, &["add", "."]).await.unwrap();
        git::git(&main, &["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "init"]).await.unwrap();
        // Keep the test from reaching for the user's signing key.
        git::git(&main, &["config", "commit.gpgsign", "false"]).await.unwrap();
        // A real workspace is a linked worktree, whose git data is elsewhere.
        let worktree = root.join("wt");
        let worktree_str = worktree.to_string_lossy().to_string();
        git::git(&main, &["worktree", "add", "-q", "-b", "t/wt", &worktree_str, "HEAD"]).await.unwrap();

        let mut store = Store::load(root.join("data"));
        store.data.repos.push(Repo { id: "r".into(), name: "repo".into(), path: main.to_string_lossy().to_string(), run_script: None, setup_script: None });
        store.data.workspaces.push(Workspace {
            id: "w".into(), repo_id: "r".into(), name: "wt".into(), branch: "t/wt".into(),
            path: worktree_str, created_at: 0, archived: false, base_sha: None, group_id: None,
            auto_pr: false, ci_fix_sha: None, ci_fix_attempts: 0, handled_threads: vec![], linked_pr: None, auto_push: false, conflict_sha: None,
        });
        let mut chat = Chat::new(Some("w".into()), None, None);
        chat.id = "x".into();
        chat.agent = "codex".into();
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

        send_message(&handle, "x", "Create a.txt containing the word alpha and commit it with git (use -c user.name=t -c user.email=t@t). Remember the code word gamma-7.").unwrap();
        wait_for_idle(&handle, "x").await;
        let events = state.store.lock().unwrap().read_events("x");
        let kinds: Vec<&str> = events.iter().filter_map(|e| e["type"].as_str()).collect();
        println!("{kinds:?}");
        assert!(worktree.join("a.txt").exists());
        let log = git::git(&worktree, &["log", "--oneline"]).await.unwrap();
        assert_eq!(log.lines().count(), 2, "Codex could not commit inside the worktree: {log}");
        assert!(kinds.contains(&"productor_snapshot"));
        assert!(events.iter().any(|e| e["message"]["content"][0]["type"] == "tool_use"));

        send_message(&handle, "x", "Reply with only the code word I told you.").unwrap();
        wait_for_idle(&handle, "x").await;
        let events = state.store.lock().unwrap().read_events("x");
        let reply = events.iter().rev().find(|e| e["type"] == "assistant").unwrap().to_string();
        assert!(reply.contains("gamma-7"), "thread was not resumed: {reply}");

        assert!(fork_chat(&handle, "x", 1, true).await.is_err(), "Codex forks only from the latest turn");
        let forked = fork_chat(&handle, "x", 2, true).await.unwrap();
        let fork_id = forked["chat"]["id"].as_str().unwrap().to_string();
        let fork_path = PathBuf::from(forked["workspace"]["path"].as_str().unwrap());
        assert_eq!(forked["chat"]["agent"], "codex");
        assert_ne!(forked["chat"]["sessionId"], events_session(&state, "x"));
        send_message(&handle, &fork_id, "Create b.txt in the current directory containing the code word I told you.").unwrap();
        wait_for_idle(&handle, &fork_id).await;
        let written = std::fs::read_to_string(fork_path.join("b.txt")).expect("b.txt was not written in the fork's worktree");
        assert!(written.contains("gamma-7"), "fork lost its history: {written}");
        assert!(!worktree.join("b.txt").exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    fn events_session(state: &AppState, chat_id: &str) -> Value {
        json!(state.store.lock().unwrap().chat(chat_id).unwrap().session_id)
    }
}
