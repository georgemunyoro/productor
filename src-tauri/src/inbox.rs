//! The inbox: pull requests on GitHub that are waiting for the user's review.
//!
//! Requests are found by asking GitHub through the `gh` CLI, which needs
//! nothing beyond the user's own login, so it works for repositories where
//! they could never install a webhook. It runs only while the app is open,
//! but each check compares against the current list, so anything requested
//! in the meantime shows up on the next one.

use crate::store::{InboxItem, LinkedPr};
use crate::{agent, git, make_quick_chat, now_ms, AppState};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};

const POLL_EVERY: Duration = Duration::from_secs(120);
const REVIEW_REQUEST: &str = "review_request";

async fn gh(path: &str) -> Result<Value, String> {
    let mut command = tokio::process::Command::new("gh");
    command.args(["api", path]).kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(45), command.output())
        .await
        .map_err(|_| "GitHub took too long to answer.".to_string())?
        .map_err(|e| format!("Could not run the GitHub CLI (gh): {e}"))?;
    if !output.status.success() {
        return Err(format!("GitHub: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())
}

/// `owner/name` from a GitHub remote URL in either SSH or HTTPS form.
pub fn repo_slug(remote: &str) -> Option<String> {
    let rest = remote
        .trim()
        .strip_prefix("git@github.com:")
        .or_else(|| remote.trim().strip_prefix("ssh://git@github.com/"))
        .or_else(|| remote.trim().strip_prefix("https://github.com/"))?;
    let slug = rest.trim_end_matches('/').trim_end_matches(".git");
    (slug.split('/').count() == 2).then(|| slug.to_string())
}

/// Turns one search result into an inbox item, if it is well formed.
fn item_from(pr: &Value) -> Option<InboxItem> {
    // Search results name their repository only by API URL.
    let repo = pr["repository_url"].as_str()?.split("/repos/").nth(1)?.to_lowercase();
    let number = pr["number"].as_i64()?;
    Some(InboxItem {
        id: uuid::Uuid::new_v4().to_string(),
        kind: REVIEW_REQUEST.into(),
        key: format!("rr:{repo}#{number}"),
        repo,
        number,
        title: pr["title"].as_str().unwrap_or("").to_string(),
        author: pr["user"]["login"].as_str().unwrap_or("").to_string(),
        url: pr["html_url"].as_str().unwrap_or("").to_string(),
        chat_id: None,
        status: "new".into(),
        summary: String::new(),
        created_at: now_ms(),
        updated_at: pr["updated_at"].as_str().unwrap_or("").to_string(),
        read: false,
        direct: pr["direct"] == true,
        dismissed: false,
    })
}

/// Brings the inbox in line with the pull requests currently awaiting the
/// user's review, and returns the items that were added. A request that has
/// gone away (reviewed, merged, closed or withdrawn) takes its item with it,
/// unless an agent has reviewed it, in which case the review is kept until
/// the user removes it. Items the user removed stay hidden while the request
/// stands, and are forgotten with it, so a later re-request shows up afresh.
fn reconcile(inbox: &mut Vec<InboxItem>, requested: &[Value]) -> Vec<InboxItem> {
    let current: Vec<InboxItem> = requested.iter().filter_map(item_from).collect();
    inbox.retain(|item| {
        item.kind != REVIEW_REQUEST || item.chat_id.is_some() || current.iter().any(|c| c.key == item.key)
    });
    let mut added = Vec::new();
    for fresh in current {
        match inbox.iter_mut().find(|item| item.key == fresh.key) {
            Some(existing) => {
                existing.title = fresh.title;
                existing.direct = fresh.direct;
                existing.updated_at = fresh.updated_at;
            }
            None => {
                inbox.push(fresh.clone());
                added.push(fresh);
            }
        }
    }
    added
}

/// Every open pull request matching a search qualifier, following GitHub's
/// pages up to a generous limit.
async fn search_all(qualifier: &str) -> Result<Vec<Value>, String> {
    let mut all = Vec::new();
    for page in 1..=5 {
        let query = format!(
            "search/issues?q=is:pr+is:open+archived:false+{qualifier}&sort=updated&order=desc&per_page=100&page={page}"
        );
        let found = gh(&query).await?;
        let items = found["items"].as_array().cloned().unwrap_or_default();
        let last = items.len() < 100;
        all.extend(items);
        if last {
            break;
        }
    }
    Ok(all)
}

/// Checks GitHub once and updates the inbox.
pub async fn sync<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    // `review-requested` covers requests made of the user by name and of any
    // team they are on, which is what GitHub's own "review requests" list
    // shows. The narrower search tells the two apart.
    let mut requested = search_all("review-requested:@me").await?;
    let by_name: Vec<Value> = search_all("user-review-requested:@me").await?.iter().map(|pr| pr["html_url"].clone()).collect();
    for pr in requested.iter_mut() {
        pr["direct"] = json!(by_name.contains(&pr["html_url"]));
    }

    let state = app.state::<AppState>();
    let added = {
        let mut store = state.store.lock().unwrap();
        let added = reconcile(&mut store.data.inbox, &requested);
        // The very first check lists what was already waiting; announcing
        // each of those as news would be noise.
        let announce = store.data.inbox_synced;
        store.data.inbox_synced = true;
        store.save()?;
        if announce { added } else { Vec::new() }
    };
    let _ = app.emit("inbox-changed", json!({ "notify": added }));
    Ok(())
}

/// The user's own open pull requests, across GitHub, newest activity first.
pub async fn my_pull_requests() -> Result<Vec<Value>, String> {
    let found = search_all("author:@me").await?;
    Ok(found
        .iter()
        .filter_map(|pr| {
            let repo = pr["repository_url"].as_str()?.split("/repos/").nth(1)?.to_lowercase();
            Some(json!({
                "repo": repo,
                "number": pr["number"],
                "title": pr["title"],
                "url": pr["html_url"],
                "draft": pr["draft"],
                "updatedAt": pr["updated_at"],
            }))
        })
        .collect())
}

/// Checks GitHub for review requests for as long as the app runs.
pub fn start<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        loop {
            // A failure here would otherwise be silent: the inbox would just
            // stop changing. Keep it where the inbox can show it.
            let outcome = sync(&app).await;
            let changed = crate::set_problem(&app, "inbox", outcome.err());
            if changed {
                let _ = app.emit("inbox-changed", json!({ "notify": [] }));
            }
            tokio::time::sleep(POLL_EVERY).await;
        }
    });
}

fn review_prompt(item: &InboxItem) -> String {
    format!(
        "My review has been requested on pull request #{number} in {repo}: {title}\n{url}\n\n\
         Review it for me. You are in a read-only checkout of the repository on its default branch, \
         not on the pull request's branch.\n\
         - Read the description and the changes with `gh pr view {number} --repo {repo}` and \
         `gh pr diff {number} --repo {repo}`.\n\
         - Read the surrounding code here to judge the changes in context. To see a file as the pull \
         request has it, run `git fetch origin pull/{number}/head` and then `git show FETCH_HEAD:<path>`.\n\
         - Do not post anything to GitHub.\n\n\
         Report back with: what the change does in a sentence or two; any bugs or risks, each with its \
         file and line; questions worth asking the author; and whether you would approve it, request \
         changes, or want another look at something first.",
        number = item.number,
        repo = item.repo,
        title = item.title,
        url = item.url,
    )
}

/// Starts an agent reviewing the pull request behind an inbox item, in a
/// read-only chat. Returns the chat's id.
pub async fn start_review<R: Runtime>(app: &AppHandle<R>, item_id: &str) -> Result<String, String> {
    let state = app.state::<AppState>();
    let (item, repos) = {
        let store = state.store.lock().unwrap();
        let item = store.data.inbox.iter().find(|i| i.id == item_id).cloned().ok_or("That item is no longer in the inbox.")?;
        (item, store.data.repos.clone())
    };
    if let Some(chat_id) = item.chat_id {
        return Ok(chat_id);
    }

    // The agent needs the code to review against, so the repository has to
    // be one Productor has a copy of.
    let mut repo_id = None;
    for repo in &repos {
        let remote = git::git(Path::new(&repo.path), &["remote", "get-url", "origin"]).await.unwrap_or_default();
        if repo_slug(&remote).is_some_and(|slug| slug.to_lowercase() == item.repo) {
            repo_id = Some(repo.id.clone());
            break;
        }
    }
    let repo_id = repo_id.ok_or(format!("Add {} to Productor to have an agent review it here.", item.repo))?;

    let mut chat = make_quick_chat(app, &repo_id).await?;
    chat.title = Some(format!("Review #{} {}", item.number, item.title).chars().take(80).collect());
    chat.inbox_id = Some(item.id.clone());
    chat.linked_pr = Some(LinkedPr { repo: item.repo.clone(), number: item.number });
    let updated = {
        let mut store = state.store.lock().unwrap();
        if let Some(stored) = store.chat_mut(&chat.id) {
            *stored = chat.clone();
        }
        let stored = store.data.inbox.iter_mut().find(|i| i.id == item_id).ok_or("That item is no longer in the inbox.")?;
        stored.chat_id = Some(chat.id.clone());
        stored.status = "running".into();
        stored.read = true;
        let updated = stored.clone();
        store.save()?;
        updated
    };
    let _ = app.emit("inbox-changed", json!({ "notify": [] }));

    if let Err(e) = agent::send_message(app, &chat.id, &review_prompt(&updated)) {
        finish(app, &chat.id, "failed", Some(e.clone()));
        return Err(e);
    }
    Ok(chat.id)
}

/// Text of the last thing the agent said in a chat.
fn last_reply(events: &[Value]) -> String {
    events
        .iter()
        .rev()
        .filter(|e| e["type"] == "assistant" && e["parent_tool_use_id"].is_null())
        .find_map(|e| {
            e["message"]["content"].as_array()?.iter().rev().find_map(|block| {
                block["text"].as_str().filter(|t| !t.trim().is_empty()).map(String::from)
            })
        })
        .unwrap_or_default()
}

fn finish<R: Runtime>(app: &AppHandle<R>, chat_id: &str, status: &str, summary: Option<String>) {
    let state = app.state::<AppState>();
    let item = {
        let mut store = state.store.lock().unwrap();
        let summary = summary.unwrap_or_else(|| last_reply(&store.read_events(chat_id)));
        let Some(item) = store
            .data
            .inbox
            .iter_mut()
            .find(|i| i.chat_id.as_deref() == Some(chat_id) && matches!(i.status.as_str(), "running" | "needs_approval"))
        else {
            return;
        };
        item.status = status.to_string();
        item.summary = summary.chars().take(600).collect();
        item.read = false;
        let item = item.clone();
        let _ = store.save();
        item
    };
    let _ = app.emit("inbox-changed", json!({ "notify": [item] }));
}

/// Called when any chat finishes a turn; completes the inbox item if the
/// chat was its review. Later turns in the same chat change nothing.
pub fn on_turn_finished<R: Runtime>(app: &AppHandle<R>, chat_id: &str, result: &Value) {
    if result["subtype"] == "error_during_execution" {
        finish(app, chat_id, "failed", Some("Stopped before it finished.".into()));
    } else if result["is_error"] == true {
        let message = result["result"].as_str().unwrap_or("The agent reported an error.").to_string();
        finish(app, chat_id, "failed", Some(message));
    } else {
        finish(app, chat_id, "done", None);
    }
}

/// Called on every chat status change; flags a review that is waiting on
/// the user to approve something, and unflags it afterwards.
pub fn on_status<R: Runtime>(app: &AppHandle<R>, chat_id: &str, status: &str) {
    let (from, to, wants_attention) = match status {
        "awaiting_permission" => ("running", "needs_approval", true),
        "running" => ("needs_approval", "running", false),
        _ => return,
    };
    let state = app.state::<AppState>();
    let item = {
        let mut store = state.store.lock().unwrap();
        let Some(item) = store.data.inbox.iter_mut().find(|i| i.chat_id.as_deref() == Some(chat_id) && i.status == from)
        else {
            return;
        };
        item.status = to.to_string();
        if wants_attention {
            item.read = false;
        }
        let item = item.clone();
        let _ = store.save();
        item
    };
    let notify = if wants_attention { json!([item]) } else { json!([]) };
    let _ = app.emit("inbox-changed", json!({ "notify": notify }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{tests::wait_for_idle, Agents};
    use crate::store::{Repo, Store};

    fn request(repo: &str, number: i64, title: &str) -> Value {
        json!({
            "number": number,
            "title": title,
            "html_url": format!("https://github.com/{repo}/pull/{number}"),
            "user": { "login": "ann" },
            "repository_url": format!("https://api.github.com/repos/{repo}"),
        })
    }

    #[test]
    fn parses_github_remotes() {
        assert_eq!(repo_slug("git@github.com:PostHog/posthog.git").as_deref(), Some("PostHog/posthog"));
        assert_eq!(repo_slug("https://github.com/o/r\n").as_deref(), Some("o/r"));
        assert_eq!(repo_slug("https://gitlab.com/o/r.git"), None);
    }

    #[test]
    fn keeps_the_inbox_in_step_with_github() {
        let mut inbox = Vec::new();
        let added = reconcile(&mut inbox, &[request("O/R", 7, "Fix login"), request("o/other", 7, "Same number")]);
        assert_eq!(added.len(), 2);
        assert_eq!(inbox[0].key, "rr:o/r#7");
        assert_eq!((inbox[0].repo.as_str(), inbox[0].author.as_str(), inbox[0].status.as_str()), ("o/r", "ann", "new"));
        assert!(!inbox[0].read && !inbox[0].direct);

        // Seeing the same requests again adds nothing, but picks up a new title.
        inbox[0].read = true;
        let mut by_name = request("o/r", 7, "Fix login properly");
        by_name["direct"] = json!(true);
        let again = [by_name, request("o/other", 7, "Same number")];
        assert!(reconcile(&mut inbox, &again).is_empty());
        assert!(inbox[0].direct, "a team request can become a personal one");
        assert_eq!(inbox[0].title, "Fix login properly");
        assert!(inbox[0].read, "an item the user has seen stays seen");

        // A request that goes away takes its item with it, unless an agent
        // reviewed it; a new request shows up alongside.
        inbox[1].chat_id = Some("chat".into());
        let added = reconcile(&mut inbox, &[request("o/r", 9, "Another")]);
        assert_eq!(added.len(), 1);
        let keys: Vec<&str> = inbox.iter().map(|i| i.key.as_str()).collect();
        assert_eq!(keys, vec!["rr:o/other#7", "rr:o/r#9"]);

        // An item the user removed stays away while the request stands...
        inbox[1].dismissed = true;
        assert!(reconcile(&mut inbox, &[request("o/r", 9, "Another")]).is_empty());
        assert!(inbox.iter().any(|i| i.key == "rr:o/r#9" && i.dismissed));
        // ...and is forgotten once the request is gone.
        inbox[0].chat_id = None;
        reconcile(&mut inbox, &[]);
        assert!(inbox.is_empty());
        reconcile(&mut inbox, &[request("o/r", 9, "Another")]);
        assert!(!inbox[0].dismissed, "asked again later, it comes back");

        // Asked again after it went away: back as a new, unread item.
        let added = reconcile(&mut inbox, &[request("o/r", 7, "Fix login properly"), request("o/r", 9, "Another")]);
        assert_eq!(added.len(), 1);
        assert!(!added[0].read);
    }

    /// The real search, read-only. Needs `gh` logged in.
    #[tokio::test]
    #[ignore]
    async fn finds_real_review_requests() {
        let root = std::env::temp_dir().join(format!("productor-inbox-{}", uuid::Uuid::new_v4()));
        let app = tauri::test::mock_app();
        app.manage(AppState {
            store: std::sync::Mutex::new(Store::load(root.clone())),
            agents: Agents::default(),
            terminals: Default::default(),
            prs: Default::default(),
            problems: Default::default(),
        });
        sync(app.handle()).await.unwrap();
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        println!("{} review request(s)", store.data.inbox.len());
        for item in &store.data.inbox {
            println!("  {} {} #{} by {}: {}", if item.direct { "you " } else { "team" }, item.repo, item.number, item.author, item.title);
            assert!(item.url.starts_with("https://github.com/") && !item.repo.is_empty() && item.number > 0);
        }
        assert!(store.data.inbox_synced);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Starting a review runs a real read-only agent in the right repository
    /// and puts its answer on the inbox item. The pull request is made up,
    /// so the agent can only report that it could not find it; what matters
    /// here is the plumbing. Needs a logged-in `claude`.
    #[tokio::test]
    #[ignore]
    async fn a_review_runs_read_only_and_reports_into_the_inbox() {
        let root = std::env::temp_dir().join(format!("productor-review-{}", uuid::Uuid::new_v4()));
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git::git(&repo, &["init", "-q"]).await.unwrap();
        std::fs::write(repo.join("README.md"), "hello").unwrap();
        git::git(&repo, &["add", "."]).await.unwrap();
        git::git(&repo, &["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "init"]).await.unwrap();
        git::git(&repo, &["remote", "add", "origin", "git@github.com:Productor-Test/Nowhere.git"]).await.unwrap();

        let mut store = Store::load(root.join("data"));
        store.data.repos.push(Repo { id: "r".into(), name: "repo".into(), path: repo.to_string_lossy().to_string(), run_script: None, setup_script: None });
        let mut inbox = Vec::new();
        reconcile(&mut inbox, &[request("productor-test/nowhere", 7, "Fix login"), request("o/unknown", 1, "Elsewhere")]);
        let (known, unknown) = (inbox[0].id.clone(), inbox[1].id.clone());
        store.data.inbox = inbox;

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

        let error = start_review(&handle, &unknown).await.unwrap_err();
        assert!(error.contains("Add o/unknown"), "{error}");

        let chat_id = start_review(&handle, &known).await.unwrap();
        assert_eq!(start_review(&handle, &known).await.unwrap(), chat_id, "a second click reuses the review");
        wait_for_idle(&handle, &chat_id).await;

        let store = state.store.lock().unwrap();
        let item = store.data.inbox.iter().find(|i| i.id == known).unwrap();
        assert_eq!(item.status, "done");
        assert!(!item.read && !item.summary.is_empty());
        println!("summary: {}", item.summary);
        let chat = store.chat(&chat_id).unwrap();
        assert_eq!(chat.inbox_id.as_deref(), Some(known.as_str()));
        assert_eq!(chat.linked_pr, Some(LinkedPr { repo: "productor-test/nowhere".into(), number: 7 }));
        assert!(chat.workspace_id.is_none(), "reviews are read-only chats");
        assert_eq!(git::git(&repo, &["status", "--porcelain"]).await.unwrap(), "");
        drop(store);
        state.agents.stop(&chat_id);
        let _ = std::fs::remove_dir_all(&root);
    }
}
