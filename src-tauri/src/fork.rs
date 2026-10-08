//! Forking a chat from the end of any of its turns.

use crate::store::{Chat, ForkSource};
use crate::{agent, codex, copy_session, make_workspace, AppState, Start, StartPoint};
use serde_json::{json, Value};
use std::path::Path;
use tauri::{AppHandle, Manager, Runtime};

/// The part of a transcript up to and including turn `turn`, plus what is
/// needed to continue from there.
struct ForkPoint {
    events: Vec<Value>,
    /// Last assistant message of the turn, where the conversation is cut.
    at_uuid: String,
    /// Snapshot of the worktree taken when the turn ended, if there was one.
    snapshot_sha: Option<String>,
}

fn fork_point(events: Vec<Value>, turn: u32) -> Result<ForkPoint, String> {
    let mut results = 0;
    let mut end = None;
    for (i, event) in events.iter().enumerate() {
        if event["type"] == "result" {
            results += 1;
            if results == turn {
                end = Some(i);
                break;
            }
        }
    }
    let mut end = end.ok_or("that turn has not finished")?;
    let mut snapshot_sha = None;
    if let Some(next) = events.get(end + 1) {
        if next["type"] == "productor_snapshot" {
            snapshot_sha = next["sha"].as_str().map(String::from);
            end += 1;
        }
    }
    let at_uuid = events[..=end]
        .iter()
        .rev()
        .find(|e| e["type"] == "assistant" && e["parent_tool_use_id"].is_null())
        .and_then(|e| e["uuid"].as_str())
        .ok_or("there is no assistant message to fork from")?
        .to_string();
    let mut events = events;
    events.truncate(end + 1);
    Ok(ForkPoint { events, at_uuid, snapshot_sha })
}

pub async fn fork_chat<R: Runtime>(
    app: &AppHandle<R>,
    chat_id: &str,
    turn: u32,
    with_worktree: bool,
) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let (source, source_ws, point) = {
        let store = state.store.lock().unwrap();
        let source = store.chat(chat_id).cloned().ok_or("chat not found")?;
        let ws = source.workspace_id.as_deref().and_then(|id| store.workspace(id)).cloned();
        (source, ws, fork_point(store.read_events(chat_id), turn)?)
    };
    // A fork that has not started yet has no session of its own; its history
    // still lives in the session it was forked from.
    let session_id = source
        .session_id
        .clone()
        .or_else(|| source.fork.as_ref().map(|f| f.session_id.clone()))
        .ok_or("this chat has no conversation to fork yet")?;
    let source_title = source.title.clone().unwrap_or_else(|| "chat".into());
    let is_codex = source.agent == "codex";
    if is_codex {
        // Codex can only fork a whole thread, so the fork has to be taken
        // while the thread ends exactly where the user asked to fork.
        if turn != source.turns {
            return Err("A Codex chat can only be forked from its latest turn.".into());
        }
        if agent::is_busy(app, chat_id) {
            return Err("Wait for Codex to finish its turn before forking.".into());
        }
    }

    let mut chat = Chat::new(source.workspace_id.clone(), source.repo_id.clone(), source.cwd.clone());
    chat.title = Some(format!("{source_title} (fork)"));
    chat.turns = turn;
    chat.agent = source.agent.clone();
    chat.linked_pr = source.linked_pr.clone();
    chat.model = source.model.clone();
    chat.fast = source.fast;
    if !is_codex {
        chat.fork = Some(ForkSource { session_id: session_id.clone(), at_uuid: point.at_uuid });
    }
    chat.group_id = source.group_id.clone();

    let mut workspace = None;
    let mut notice = format!("Forked from \u{201c}{source_title}\u{201d} after turn {turn}");
    if with_worktree {
        let source_ws = source_ws.as_ref().ok_or("only a workspace chat can be forked into a new workspace")?;
        let snapshot_sha = point.snapshot_sha.clone().ok_or("no code snapshot was taken at that turn")?;
        let start = StartPoint {
            snapshot_sha,
            base_sha: source_ws.base_sha.clone(),
            group_id: source_ws.group_id.clone(),
        };
        let mut ws = make_workspace(&state, &source_ws.repo_id, Start::Snapshot(start)).await?;
        // A fork of a review is still a review of the same pull request.
        if source_ws.linked_pr.is_some() {
            ws.linked_pr = source_ws.linked_pr.clone();
            let mut store = state.store.lock().unwrap();
            if let Some(stored) = store.data.workspaces.iter_mut().find(|w| w.id == ws.id) {
                stored.linked_pr = ws.linked_pr.clone();
            }
            store.save()?;
        }
        if !is_codex {
            copy_session(&session_id, Path::new(&source_ws.path), Path::new(&ws.path))?;
        }
        chat.workspace_id = Some(ws.id.clone());
        chat.pending_note = Some(format!(
            "This conversation was forked into a new git worktree at {} on branch {}, holding the code exactly \
             as it was at this point. Work only there from now on, at the same relative paths. The original \
             worktree at {} now belongs to a different line of work: do not read or change it.",
            ws.path, ws.branch, source_ws.path
        ));
        notice = format!("{notice}, into workspace {} on {}", ws.name, ws.branch);
        workspace = Some(ws);
    }

    if is_codex {
        let cwd = match &workspace {
            Some(ws) => ws.path.clone(),
            None => source_ws.as_ref().map(|ws| ws.path.clone()).or(source.cwd.clone()).unwrap_or_default(),
        };
        chat.session_id = Some(codex::fork_thread(&session_id, Path::new(&cwd)).await?);
    }

    {
        let mut store = state.store.lock().unwrap();
        for event in &point.events {
            store.append_event(&chat.id, event);
        }
        store.data.chats.push(chat.clone());
        store.save()?;
    }
    agent::notice(app, &chat.id, &notice);
    Ok(json!({ "chat": chat, "workspace": workspace }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git;
    use crate::agent::{send_message, tests::wait_for_idle, Agents};
    use crate::store::{Repo, Store, Workspace};

    fn last_reply(state: &AppState, chat_id: &str) -> String {
        let events = state.store.lock().unwrap().read_events(chat_id);
        events.iter().rev().find(|e| e["type"] == "assistant").map(|e| e.to_string()).unwrap_or_default()
    }

    /// Forks a real conversation three ways and checks each fork remembers
    /// exactly what it should and has exactly the code it should. Needs a
    /// logged-in `claude`: cargo test fork -- --ignored
    #[tokio::test]
    #[ignore]
    async fn forks_keep_the_right_history_and_code() {
        let root = std::env::temp_dir().join(format!("productor-fork-{}", uuid::Uuid::new_v4()));
        std::env::set_var("PRODUCTOR_HOME", root.join("home"));
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git::git(&repo, &["init", "-q"]).await.unwrap();
        std::fs::write(repo.join("README.md"), "hello").unwrap();
        git::git(&repo, &["add", "."]).await.unwrap();
        git::git(&repo, &["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "init"]).await.unwrap();
        let head = git::git(&repo, &["rev-parse", "HEAD"]).await.unwrap();

        let mut store = Store::load(root.join("data"));
        let path = repo.to_string_lossy().to_string();
        store.data.repos.push(Repo { id: "r".into(), name: "repo".into(), path: path.clone(), run_script: None, setup_script: None });
        store.data.workspaces.push(Workspace {
            id: "w".into(), repo_id: "r".into(), name: "w".into(), branch: "main".into(),
            path, created_at: 0, archived: false, base_sha: Some(head.clone()), group_id: Some("g".into()),
            auto_pr: false, ci_fix_sha: None, ci_fix_attempts: 0, handled_threads: vec![], linked_pr: None, auto_push: false, conflict_sha: None,
        });
        let mut chat = Chat::new(Some("w".into()), None, None);
        chat.id = "a".into();
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

        send_message(&handle, "a", "Create a.txt containing the word one. Also remember: the first code word is alpha-1.").unwrap();
        wait_for_idle(&handle, "a").await;
        send_message(&handle, "a", "Create b.txt containing the word two. Also remember: the second code word is beta-2.").unwrap();
        wait_for_idle(&handle, "a").await;
        assert!(repo.join("b.txt").exists());

        // Chat-only fork from turn 1: same worktree, shorter memory.
        let forked = fork_chat(&handle, "a", 1, false).await.unwrap();
        let b = forked["chat"]["id"].as_str().unwrap().to_string();
        assert!(forked["workspace"].is_null());
        send_message(&handle, &b, "List every code word I have told you, and nothing else.").unwrap();
        wait_for_idle(&handle, &b).await;
        let reply = last_reply(&state, &b);
        assert!(reply.contains("alpha-1"), "fork lost its history: {reply}");
        assert!(!reply.contains("beta-2"), "fork remembers a later turn: {reply}");
        assert_eq!(state.store.lock().unwrap().chat(&b).unwrap().turns, 2);

        // Worktree fork from turn 1: the code as it was then, uncommitted.
        let forked = fork_chat(&handle, "a", 1, true).await.unwrap();
        let c = forked["chat"]["id"].as_str().unwrap().to_string();
        let worktree = std::path::PathBuf::from(forked["workspace"]["path"].as_str().unwrap());
        assert_eq!(forked["workspace"]["groupId"], "g");
        assert!(worktree.join("a.txt").exists());
        assert!(!worktree.join("b.txt").exists());
        assert_eq!(git::git(&worktree, &["rev-parse", "HEAD"]).await.unwrap(), head);
        assert_eq!(git::git(&worktree, &["status", "--porcelain"]).await.unwrap(), "?? a.txt");
        send_message(&handle, &c, "Create c.txt in the current directory containing every code word I have told you.").unwrap();
        wait_for_idle(&handle, &c).await;
        let written = std::fs::read_to_string(worktree.join("c.txt")).expect("c.txt was not written in the fork's worktree");
        assert!(written.contains("alpha-1") && !written.contains("beta-2"), "unexpected c.txt: {written}");
        assert!(!repo.join("c.txt").exists(), "the fork wrote into the original worktree");

        // Fork of a fork, at a turn the first fork inherited.
        let forked = fork_chat(&handle, &b, 1, false).await.unwrap();
        let d = forked["chat"]["id"].as_str().unwrap().to_string();
        send_message(&handle, &d, "List every code word I have told you, and nothing else.").unwrap();
        wait_for_idle(&handle, &d).await;
        let reply = last_reply(&state, &d);
        assert!(reply.contains("alpha-1") && !reply.contains("beta-2"), "fork of a fork: {reply}");

        for id in ["a", b.as_str(), c.as_str(), d.as_str()] {
            state.agents.stop(id);
        }
        let _ = std::fs::remove_dir_all(&root);
    }
}
