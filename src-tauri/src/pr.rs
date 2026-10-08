//! Pull request lifecycle for workspaces: what state each workspace's pull
//! request is in on GitHub, and getting the workspace's agent to fix failing
//! CI or respond to review comments.
//!
//! Everything goes through the `gh` CLI in the workspace's worktree, so it
//! needs only the user's own login. The agent's work stays behind the usual
//! approvals: pushing, commenting and merging all wait for the user.

use crate::store::{LinkedPr, Workspace};
use crate::{agent, AppState};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::process::Command;

const POLL_EVERY: Duration = Duration::from_secs(120);
/// How many times in a row CI is fixed unprompted before waiting for the user.
const MAX_AUTO_FIXES: u32 = 3;

#[derive(Serialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrStatus {
    pub number: i64,
    pub title: String,
    pub url: String,
    /// OPEN, MERGED or CLOSED.
    pub state: String,
    pub draft: bool,
    /// passing, failing, pending or none.
    pub ci: String,
    pub failing_checks: Vec<String>,
    /// approved, changes_requested, review_required or none.
    pub review: String,
    /// Review threads nobody has resolved, by id.
    pub unresolved_threads: Vec<String>,
    /// mergeable, conflicting or unknown.
    pub mergeable: String,
    pub head_sha: String,
}

impl PrStatus {
    /// Nothing stands between this pull request and being merged.
    pub fn ready_to_merge(&self) -> bool {
        self.state == "OPEN"
            && !self.draft
            && self.mergeable == "mergeable"
            && matches!(self.ci.as_str(), "passing" | "none")
            && self.review != "changes_requested"
            && self.unresolved_threads.is_empty()
    }
}

#[derive(Default)]
pub struct PrState {
    /// By workspace id. A workspace with no pull request has no entry.
    statuses: Mutex<HashMap<String, PrStatus>>,
}

impl PrState {
    pub fn all(&self) -> HashMap<String, PrStatus> {
        self.statuses.lock().unwrap().clone()
    }
}

/// Sums GitHub's per-check results into one verdict, and names the failures.
fn rollup(checks: &[Value]) -> (String, Vec<String>) {
    let mut failing = Vec::new();
    let mut pending = false;
    for check in checks {
        let name = check["name"].as_str().or(check["context"].as_str()).unwrap_or("check").to_string();
        // Check runs report status and conclusion; older commit statuses
        // report a single state.
        let outcome = check["conclusion"].as_str().filter(|c| !c.is_empty()).or(check["state"].as_str()).unwrap_or("");
        match outcome {
            "FAILURE" | "TIMED_OUT" | "STARTUP_FAILURE" | "ERROR" => failing.push(name),
            "" | "PENDING" | "EXPECTED" => pending = true,
            _ => {}
        }
    }
    failing.sort();
    failing.dedup();
    let verdict = if !failing.is_empty() {
        "failing"
    } else if pending {
        "pending"
    } else if checks.is_empty() {
        "none"
    } else {
        "passing"
    };
    (verdict.to_string(), failing)
}

fn parse_status(pr: &Value, threads: &Value) -> PrStatus {
    let (ci, failing_checks) = rollup(pr["statusCheckRollup"].as_array().map_or(&[][..], Vec::as_slice));
    let unresolved_threads = threads["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"]
        .as_array()
        .map(|nodes| {
            nodes
                .iter()
                // An outdated thread is about code that has since changed.
                .filter(|t| t["isResolved"] == false && t["isOutdated"] != true)
                .filter_map(|t| t["id"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let text = |key: &str| pr[key].as_str().unwrap_or("").to_string();
    PrStatus {
        number: pr["number"].as_i64().unwrap_or(0),
        title: text("title"),
        url: text("url"),
        state: text("state"),
        draft: pr["isDraft"] == true,
        ci,
        failing_checks,
        review: match pr["reviewDecision"].as_str() {
            Some("APPROVED") => "approved",
            Some("CHANGES_REQUESTED") => "changes_requested",
            Some("REVIEW_REQUIRED") => "review_required",
            _ => "none",
        }
        .to_string(),
        unresolved_threads,
        mergeable: match pr["mergeable"].as_str() {
            Some("MERGEABLE") => "mergeable",
            Some("CONFLICTING") => "conflicting",
            _ => "unknown",
        }
        .to_string(),
        head_sha: text("headRefOid"),
    }
}

pub(crate) async fn gh(dir: &Path, args: &[&str]) -> Result<Value, String> {
    let mut command = Command::new("gh");
    command.current_dir(dir).args(args).kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(45), command.output())
        .await
        .map_err(|_| "GitHub took too long to answer".to_string())?
        .map_err(|e| format!("Could not run the GitHub CLI (gh): {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())
}

/// The pull request `linked` names or, without one, the pull request for
/// the branch checked out in `worktree`, if it has one.
pub async fn fetch_status(worktree: &Path, linked: Option<&LinkedPr>) -> Result<Option<PrStatus>, String> {
    let fields = "number,title,url,state,isDraft,mergeable,reviewDecision,headRefOid,statusCheckRollup";
    let number = linked.map(|l| l.number.to_string()).unwrap_or_default();
    let args: Vec<&str> = match linked {
        Some(linked) => vec!["pr", "view", &number, "--repo", &linked.repo, "--json", fields],
        None => vec!["pr", "view", "--json", fields],
    };
    let pr = match gh(worktree, &args).await {
        Ok(pr) => pr,
        Err(e) if e.contains("no pull requests found") => return Ok(None),
        Err(e) => return Err(e),
    };
    // https://github.com/<owner>/<name>/pull/<number>
    let url = pr["url"].as_str().unwrap_or("");
    let mut parts = url.trim_start_matches("https://github.com/").split('/');
    let (owner, name) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let query = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){\
                 pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved isOutdated}}}}}";
    let threads = gh(
        worktree,
        &[
            "api", "graphql",
            "-f", &format!("query={query}"),
            "-F", &format!("owner={owner}"),
            "-F", &format!("name={name}"),
            "-F", &format!("number={}", pr["number"]),
        ],
    )
    .await
    // The thread count is a refinement; the rest still stands without it.
    .unwrap_or(Value::Null);
    Ok(Some(parse_status(&pr, &threads)))
}

fn fix_ci_prompt(pr: &PrStatus) -> String {
    let checks = if pr.failing_checks.is_empty() { "(see GitHub)".to_string() } else { pr.failing_checks.join(", ") };
    format!(
        "CI is failing on this workspace's pull request #{n} ({url}).\nFailing checks: {checks}\n\n\
         Find out why with `gh pr checks {n}` and `gh run view <run-id> --log-failed`, fix the cause in this \
         worktree, run the relevant tests here to confirm, commit, and push. If a failure has nothing to do \
         with this pull request's changes (flaky or broken on the base branch), say so instead of changing code.",
        n = pr.number,
        url = pr.url,
    )
}

fn address_comments_prompt(pr: &PrStatus) -> String {
    format!(
        "There are {count} unresolved review thread(s) on this workspace's pull request #{n} ({url}).\n\n\
         Read them (for example `gh pr view {n} --comments` and \
         `gh api repos/{{owner}}/{{repo}}/pulls/{n}/comments`). For each one, either make the change it asks \
         for, or draft a reply if you disagree or it needs an answer rather than a change. Commit your changes \
         locally.\n\nDo not push and do not post anything to GitHub yet. Finish with a list of every thread: \
         who said what, and what you changed or the reply you propose. I will review that before anything goes out.",
        count = pr.unresolved_threads.len(),
        n = pr.number,
        url = pr.url,
    )
}

fn resolve_conflicts_prompt(pr: &PrStatus) -> String {
    format!(
        "This workspace's pull request #{n} ({url}) has merge conflicts with its base branch.\n\n\
         Find the base branch with `gh pr view {n} --json baseRefName`, fetch it, and merge it into this \
         branch (merge rather than rebase, so nothing already pushed is rewritten). Resolve each conflict by \
         understanding what both sides intended; do not just take one side. Run the relevant tests, commit \
         the merge, and push. If a conflict needs a decision you cannot make from the code, stop and ask.",
        n = pr.number,
        url = pr.url,
    )
}

const CREATE_PR_PROMPT: &str = "Open a pull request for this workspace's branch. Commit anything \
    uncommitted that belongs in it, push the branch, and create the pull request with `gh pr create`, with \
    a title and description that say what changed and why. Follow the repository's pull request template \
    and conventions if it has them.";

/// What a status change is worth telling the user about, if anything.
fn news(name: &str, old: Option<&PrStatus>, new: &PrStatus) -> Option<(String, String)> {
    let old = old?;
    let subject = format!("{name}: #{} {}", new.number, new.title);
    if old.state == "OPEN" && new.state == "MERGED" {
        Some(("Pull request merged".into(), subject))
    } else if old.ci != "failing" && new.ci == "failing" {
        Some(("CI failed".into(), subject))
    } else if old.review != "changes_requested" && new.review == "changes_requested" {
        Some(("Changes requested".into(), subject))
    } else if new.unresolved_threads.iter().any(|t| !old.unresolved_threads.contains(t)) {
        Some(("New review comments".into(), subject))
    } else if !old.ready_to_merge() && new.ready_to_merge() {
        Some(("Ready to merge".into(), subject))
    } else {
        None
    }
}

/// The chat a workspace's agent should be addressed in: its newest one.
fn workspace_chat<R: Runtime>(app: &AppHandle<R>, workspace_id: &str) -> Option<String> {
    let state = app.state::<AppState>();
    let store = state.store.lock().unwrap();
    store.data.chats.iter().rev().find(|c| c.workspace_id.as_deref() == Some(workspace_id)).map(|c| c.id.clone())
}

/// Asks the workspace's agent to do something about its pull request, and
/// records that it was asked so the same thing is not asked again unprompted.
pub fn act<R: Runtime>(app: &AppHandle<R>, workspace_id: &str, chat_id: Option<String>, action: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let reviewing = state.store.lock().unwrap().workspace(workspace_id).is_some_and(|w| w.linked_pr.is_some());
    if reviewing {
        return Err("This workspace is reviewing someone else's pull request, so there is nothing of its own to fix or open.".into());
    }
    let status = state.prs.statuses.lock().unwrap().get(workspace_id).cloned();
    let prompt = match (action, &status) {
        ("create_pr", _) => CREATE_PR_PROMPT.to_string(),
        ("fix_ci", Some(pr)) => fix_ci_prompt(pr),
        ("address_comments", Some(pr)) => address_comments_prompt(pr),
        ("resolve_conflicts", Some(pr)) => resolve_conflicts_prompt(pr),
        _ => return Err("This workspace has no pull request yet.".into()),
    };
    let chat_id = chat_id.or_else(|| workspace_chat(app, workspace_id)).ok_or("This workspace has no chat.")?;
    if agent::is_busy(app, &chat_id) {
        return Err("The agent is in the middle of a turn. Try again when it has finished.".into());
    }
    agent::send_message(app, &chat_id, &prompt)?;

    let mut store = state.store.lock().unwrap();
    if let (Some(ws), Some(pr)) = (store.data.workspaces.iter_mut().find(|w| w.id == workspace_id), &status) {
        match action {
            "fix_ci" => ws.ci_fix_sha = Some(pr.head_sha.clone()),
            "resolve_conflicts" => ws.conflict_sha = Some(pr.head_sha.clone()),
            "address_comments" => {
                for thread in &pr.unresolved_threads {
                    if !ws.handled_threads.contains(thread) {
                        ws.handled_threads.push(thread.clone());
                    }
                }
            }
            _ => {}
        }
        let _ = store.save();
    }
    Ok(())
}

/// For a workspace set to look after its own pull request: starts the agent
/// on newly failing CI or newly arrived review comments.
fn look_after<R: Runtime>(app: &AppHandle<R>, workspace: &Workspace, pr: &PrStatus) {
    // Never act unasked on a pull request that is only being reviewed.
    if !workspace.auto_pr || pr.state != "OPEN" || workspace.linked_pr.is_some() {
        return;
    }
    let state = app.state::<AppState>();
    if pr.ci == "passing" && workspace.ci_fix_attempts > 0 {
        let mut store = state.store.lock().unwrap();
        if let Some(ws) = store.data.workspaces.iter_mut().find(|w| w.id == workspace.id) {
            ws.ci_fix_attempts = 0;
            let _ = store.save();
        }
    }
    let Some(chat_id) = workspace_chat(app, &workspace.id) else { return };
    if agent::is_busy(app, &chat_id) {
        return;
    }

    // Conflicts come first: CI and reviewers both judge the merged result.
    if pr.mergeable == "conflicting" && workspace.conflict_sha.as_deref() != Some(pr.head_sha.as_str()) {
        let _ = act(app, &workspace.id, Some(chat_id), "resolve_conflicts");
        return;
    }

    // One attempt per commit, and only so many in a row, so a failure the
    // agent cannot fix does not turn into an endless loop of pushes.
    let untried = workspace.ci_fix_sha.as_deref() != Some(pr.head_sha.as_str());
    if pr.ci == "failing" && untried && workspace.ci_fix_attempts < MAX_AUTO_FIXES {
        if act(app, &workspace.id, Some(chat_id), "fix_ci").is_ok() {
            let mut store = state.store.lock().unwrap();
            if let Some(ws) = store.data.workspaces.iter_mut().find(|w| w.id == workspace.id) {
                ws.ci_fix_attempts += 1;
                let _ = store.save();
            }
        }
        return;
    }
    if pr.unresolved_threads.iter().any(|t| !workspace.handled_threads.contains(t)) {
        let _ = act(app, &workspace.id, Some(chat_id), "address_comments");
    }
}

/// Something whose pull request is tracked: a workspace, or a read-only
/// review chat that has not been promoted into one.
struct Target {
    /// Workspace id or chat id; the key its status is stored under.
    id: String,
    name: String,
    dir: PathBuf,
    linked: Option<LinkedPr>,
    workspace: Option<Workspace>,
}

fn targets<R: Runtime>(app: &AppHandle<R>) -> Vec<Target> {
    let state = app.state::<AppState>();
    let store = state.store.lock().unwrap();
    let workspaces = store.data.workspaces.iter().filter(|w| !w.archived).map(|w| Target {
        id: w.id.clone(),
        name: w.name.clone(),
        dir: PathBuf::from(&w.path),
        linked: w.linked_pr.clone(),
        workspace: Some(w.clone()),
    });
    let reviews = store.data.chats.iter().filter(|c| c.workspace_id.is_none()).filter_map(|c| {
        Some(Target {
            id: c.id.clone(),
            name: c.title.clone().unwrap_or_default(),
            dir: PathBuf::from(c.cwd.clone()?),
            linked: Some(c.linked_pr.clone()?),
            workspace: None,
        })
    });
    workspaces.chain(reviews).collect()
}

/// Re-reads from GitHub the pull request of one workspace or review chat.
pub async fn refresh<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    let Some(target) = targets(app).into_iter().find(|t| t.id == id) else { return Ok(()) };
    let fetched = fetch_status(&target.dir, target.linked.as_ref()).await?;

    let state = app.state::<AppState>();
    let (changed, notify) = {
        let mut statuses = state.prs.statuses.lock().unwrap();
        let old = statuses.get(id).cloned();
        // Events on a pull request under review are its author's business;
        // only the user's own pull requests are worth interrupting them for.
        let notify = match (&fetched, &target.linked) {
            (Some(new), None) => news(&target.name, old.as_ref(), new),
            _ => None,
        };
        let changed = old != fetched;
        match &fetched {
            Some(new) => statuses.insert(id.to_string(), new.clone()),
            None => statuses.remove(id),
        };
        (changed, notify)
    };
    if changed {
        let notify: Vec<Value> = notify.into_iter().map(|(title, body)| json!({ "title": title, "body": body })).collect();
        let _ = app.emit("pr-changed", json!({ "notify": notify }));
    }
    if let (Some(pr), Some(workspace)) = (&fetched, &target.workspace) {
        look_after(app, workspace, pr);
    }
    Ok(())
}

async fn refresh_all<R: Runtime>(app: &AppHandle<R>) {
    let current: Vec<String> = targets(app).into_iter().map(|t| t.id).collect();
    // Forget statuses of things that are gone: archived workspaces, deleted
    // or promoted review chats.
    app.state::<AppState>().prs.statuses.lock().unwrap().retain(|id, _| current.contains(id));
    let mut failure = None;
    for id in current {
        if let Err(e) = refresh(app, &id).await {
            failure = Some(e);
        }
    }
    // One line for the whole sweep is enough to say GitHub is unreachable.
    if crate::set_problem(app, "prs", failure) {
        let _ = app.emit("pr-changed", json!({ "notify": [] }));
    }
}

/// Keeps every workspace's pull request status current while the app runs.
pub fn start<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        loop {
            refresh_all(&app).await;
            tokio::time::sleep(POLL_EVERY).await;
        }
    });
}

/// Called when a chat finishes a turn: the agent may just have pushed or
/// opened a pull request, so look again without waiting for the next poll.
pub fn on_turn_finished<R: Runtime>(app: &AppHandle<R>, chat_id: &str) {
    let target = {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        // A review chat is tracked under its own id until it is promoted.
        store.chat(chat_id).and_then(|c| c.workspace_id.clone().or_else(|| c.linked_pr.as_ref().map(|_| c.id.clone())))
    };
    let Some(workspace_id) = target else { return };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // GitHub takes a moment to register a push and start its checks.
        tokio::time::sleep(Duration::from_secs(8)).await;
        let _ = refresh(&app, &workspace_id).await;
    });
}

/// Squash-merges every pull request in a group that is ready, and says what
/// happened to each. Anything not ready is left alone.
pub async fn merge_group<R: Runtime>(app: &AppHandle<R>, group_id: &str) -> Result<Vec<String>, String> {
    let state = app.state::<AppState>();
    let workspaces: Vec<Workspace> = {
        let store = state.store.lock().unwrap();
        store.data.workspaces.iter().filter(|w| w.group_id.as_deref() == Some(group_id) && !w.archived).cloned().collect()
    };
    let mut report = Vec::new();
    for workspace in workspaces {
        if workspace.linked_pr.is_some() {
            report.push(format!("{}: reviewing someone else's pull request, left alone", workspace.name));
            continue;
        }
        // Decide on what GitHub says now, not on what was true at the last poll.
        let status = match fetch_status(Path::new(&workspace.path), None).await {
            Ok(Some(status)) => status,
            Ok(None) => {
                report.push(format!("{}: no pull request", workspace.name));
                continue;
            }
            Err(e) => {
                report.push(format!("{}: could not check ({e})", workspace.name));
                continue;
            }
        };
        if status.state != "OPEN" {
            report.push(format!("{} #{}: already {}", workspace.name, status.number, status.state.to_lowercase()));
        } else if !status.ready_to_merge() {
            report.push(format!("{} #{}: not ready, skipped ({})", workspace.name, status.number, blockers(&status).join(", ")));
        } else {
            let number = status.number.to_string();
            let merged = Command::new("gh")
                .current_dir(&workspace.path)
                .args(["pr", "merge", &number, "--squash"])
                .output()
                .await;
            match merged {
                Ok(out) if out.status.success() => report.push(format!("{} #{}: merged", workspace.name, status.number)),
                Ok(out) => report.push(format!(
                    "{} #{}: merge failed ({})",
                    workspace.name,
                    status.number,
                    String::from_utf8_lossy(&out.stderr).trim()
                )),
                Err(e) => report.push(format!("{} #{}: merge failed ({e})", workspace.name, status.number)),
            }
        }
        let _ = refresh(app, &workspace.id).await;
    }
    Ok(report)
}

/// Why a pull request cannot be merged yet, in plain words.
pub fn blockers(pr: &PrStatus) -> Vec<&'static str> {
    let mut blockers = Vec::new();
    if pr.draft {
        blockers.push("draft");
    }
    match pr.ci.as_str() {
        "failing" => blockers.push("CI failing"),
        "pending" => blockers.push("CI running"),
        _ => {}
    }
    if pr.review == "changes_requested" {
        blockers.push("changes requested");
    }
    if !pr.unresolved_threads.is_empty() {
        blockers.push("unresolved comments");
    }
    match pr.mergeable.as_str() {
        "conflicting" => blockers.push("merge conflicts"),
        "unknown" => blockers.push("mergeability unknown"),
        _ => {}
    }
    blockers
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(conclusion: &str, name: &str) -> Value {
        json!({ "__typename": "CheckRun", "name": name, "status": "COMPLETED", "conclusion": conclusion })
    }

    #[test]
    fn sums_checks_into_one_verdict() {
        assert_eq!(rollup(&[]).0, "none");
        assert_eq!(rollup(&[run("SUCCESS", "a"), run("SKIPPED", "b"), run("NEUTRAL", "c")]).0, "passing");
        let running = json!({ "__typename": "CheckRun", "name": "d", "status": "IN_PROGRESS", "conclusion": "" });
        assert_eq!(rollup(&[run("SUCCESS", "a"), running.clone()]).0, "pending");
        // One failure decides it, even while other checks are still running.
        let (verdict, failing) = rollup(&[run("FAILURE", "tests"), running, run("TIMED_OUT", "e2e"), run("FAILURE", "tests")]);
        assert_eq!(verdict, "failing");
        assert_eq!(failing, vec!["e2e", "tests"]);
        let legacy = json!({ "__typename": "StatusContext", "context": "ci/legacy", "state": "ERROR" });
        assert_eq!(rollup(&[legacy]), ("failing".to_string(), vec!["ci/legacy".to_string()]));
    }

    fn status() -> PrStatus {
        let pr = json!({
            "number": 12, "title": "Fix login", "url": "https://github.com/o/r/pull/12", "state": "OPEN",
            "isDraft": false, "mergeable": "MERGEABLE", "reviewDecision": "APPROVED", "headRefOid": "abc",
            "statusCheckRollup": [run("SUCCESS", "tests")],
        });
        let threads = json!({ "data": { "repository": { "pullRequest": { "reviewThreads": { "nodes": [
            { "id": "t1", "isResolved": true, "isOutdated": false },
            { "id": "t2", "isResolved": false, "isOutdated": true },
        ] } } } } });
        parse_status(&pr, &threads)
    }

    #[test]
    fn reads_a_pull_request_and_judges_readiness() {
        let ready = status();
        assert_eq!((ready.ci.as_str(), ready.review.as_str(), ready.mergeable.as_str()), ("passing", "approved", "mergeable"));
        assert!(ready.unresolved_threads.is_empty(), "resolved and outdated threads do not count");
        assert!(ready.ready_to_merge());
        assert!(blockers(&ready).is_empty());

        let mut blocked = ready.clone();
        blocked.ci = "failing".into();
        blocked.unresolved_threads = vec!["t3".into()];
        blocked.mergeable = "conflicting".into();
        assert!(!blocked.ready_to_merge());
        assert_eq!(blockers(&blocked), vec!["CI failing", "unresolved comments", "merge conflicts"]);

        let mut draft = ready.clone();
        draft.draft = true;
        assert!(!draft.ready_to_merge());
    }

    #[test]
    fn reports_only_changes_worth_interrupting_for() {
        let ready = status();
        assert_eq!(news("ws", None, &ready), None, "first sight of a pull request is not news");
        assert_eq!(news("ws", Some(&ready), &ready), None);

        let mut failing = ready.clone();
        failing.ci = "failing".into();
        assert_eq!(news("ws", Some(&ready), &failing).unwrap().0, "CI failed");
        assert_eq!(news("ws", Some(&failing), &failing), None, "still failing is not news again");
        assert_eq!(news("ws", Some(&failing), &ready).unwrap().0, "Ready to merge");

        let mut commented = ready.clone();
        commented.unresolved_threads = vec!["t9".into()];
        assert_eq!(news("ws", Some(&ready), &commented).unwrap().0, "New review comments");

        let mut merged = ready.clone();
        merged.state = "MERGED".into();
        assert_eq!(news("ws", Some(&ready), &merged).unwrap().0, "Pull request merged");
    }

    #[test]
    fn prompts_name_the_pull_request_and_its_failures() {
        let mut pr = status();
        pr.failing_checks = vec!["tests".into(), "lint".into()];
        let prompt = fix_ci_prompt(&pr);
        assert!(prompt.contains("#12") && prompt.contains("tests, lint") && prompt.contains("gh pr checks 12"));
        pr.unresolved_threads = vec!["a".into(), "b".into()];
        let prompt = address_comments_prompt(&pr);
        assert!(prompt.contains("2 unresolved") && prompt.contains("Do not push"));
        assert!(prompt.contains("repos/{owner}/{repo}/pulls/12/comments"), "{prompt}");
        let prompt = resolve_conflicts_prompt(&pr);
        assert!(prompt.contains("gh pr view 12 --json baseRefName") && prompt.contains("merge rather than rebase"));
    }

    /// Reads a real pull request, read-only. Needs `gh` logged in and a
    /// checkout whose branch has one:
    /// PRODUCTOR_PR_DIR=/path/to/checkout cargo test reads_a_real -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn reads_a_real_pull_request() {
        let dir = std::env::var("PRODUCTOR_PR_DIR").expect("set PRODUCTOR_PR_DIR");
        let status = fetch_status(Path::new(&dir), None).await.unwrap().expect("that branch has no pull request");
        // The same pull request, asked for by number from anywhere.
        let repo = status.url.trim_start_matches("https://github.com/").split("/pull/").next().unwrap().to_string();
        let linked = LinkedPr { repo, number: status.number };
        let by_number = fetch_status(&std::env::temp_dir(), Some(&linked)).await.unwrap().unwrap();
        assert_eq!(by_number.head_sha, status.head_sha);
        println!("{status:#?}\nblockers: {:?}", blockers(&status));
        assert!(status.number > 0 && status.url.contains("/pull/") && !status.head_sha.is_empty());
        assert!(["passing", "failing", "pending", "none"].contains(&status.ci.as_str()));
    }
}
