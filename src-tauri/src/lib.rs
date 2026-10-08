mod agent;
mod codex;
mod files;
mod fork;
mod git;
mod inbox;
mod pr;
mod store;
mod terminal;

use agent::Agents;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use store::{Chat, Group, Repo, Store, Workspace};
use tauri::{AppHandle, Manager, Runtime, State};

pub struct AppState {
    pub store: Mutex<Store>,
    pub agents: Agents,
    pub terminals: terminal::Terminals,
    pub prs: pr::PrState,
    /// Background work that is currently failing, by what it is ("inbox",
    /// "prs"), so the interface can say so instead of silently going stale.
    pub problems: Mutex<std::collections::HashMap<String, String>>,
}

/// Records or clears a background problem; returns whether that changed anything.
pub fn set_problem<R: Runtime>(app: &AppHandle<R>, what: &str, problem: Option<String>) -> bool {
    let state = app.state::<AppState>();
    let mut problems = state.problems.lock().unwrap();
    match problem {
        Some(problem) => problems.insert(what.to_string(), problem.clone()) != Some(problem),
        None => problems.remove(what).is_some(),
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Root of everything Productor checks out: `~/productor` unless overridden.
fn productor_dir() -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("PRODUCTOR_HOME") {
        return Ok(PathBuf::from(dir));
    }
    let home = std::env::var("HOME").map_err(|_| "HOME is not set")?;
    Ok(PathBuf::from(home).join("productor"))
}

/// Where a new workspace's code comes from.
pub enum Start {
    /// The repository's default branch, freshly fetched.
    Default,
    /// Another workspace as it was at one of its turns.
    Snapshot(StartPoint),
    /// A specific commit, such as the head of a pull request under review.
    Commit(String),
}

/// A point in another workspace's history to start a new workspace from.
pub struct StartPoint {
    /// Per-turn snapshot commit holding the full working tree at that point.
    pub snapshot_sha: String,
    pub base_sha: Option<String>,
    pub group_id: Option<String>,
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

const WORKSPACE_NAMES: &[&str] = &[
    "accra", "algiers", "athens", "bamako", "bogota", "cairo", "dakar", "delhi", "denver",
    "dublin", "geneva", "hanoi", "harare", "havana", "jakarta", "kigali", "kyoto", "lagos",
    "lima", "lisbon", "lusaka", "madrid", "manila", "maputo", "milan", "nairobi", "oslo",
    "perth", "prague", "quito", "riga", "seoul", "sofia", "taipei", "tunis", "vienna",
    "warsaw", "zurich",
];

fn pick_name(taken: &[String]) -> String {
    let start = uuid::Uuid::new_v4().as_u128() as usize % WORKSPACE_NAMES.len();
    for round in 1.. {
        for i in 0..WORKSPACE_NAMES.len() {
            let base = WORKSPACE_NAMES[(start + i) % WORKSPACE_NAMES.len()];
            let name = if round == 1 { base.to_string() } else { format!("{base}-{round}") };
            if !taken.contains(&name) {
                return name;
            }
        }
    }
    unreachable!()
}

#[tauri::command]
fn get_state(state: State<AppState>) -> Value {
    let store = state.store.lock().unwrap();
    json!({
        "repos": store.data.repos,
        "workspaces": store.data.workspaces,
        "chats": store.data.chats,
        "groups": store.data.groups,
        "inbox": store.data.inbox,
        "settings": store.data.settings,
        "prs": state.prs.all(),
        "statuses": state.agents.statuses(),
        "permissions": state.agents.pending(),
        "problems": *state.problems.lock().unwrap(),
        "claudeFastRefused": agent::fast_refused(),
    })
}

/// `~/code/app` -> app, `~/code/app.git` -> app, `~/code/app/.bare` -> app.
fn repo_name(root: &Path) -> String {
    let file_name = |p: &Path| p.file_name().map(|n| n.to_string_lossy().to_string());
    let name = file_name(root).unwrap_or_default();
    if name.starts_with('.') {
        if let Some(parent) = root.parent().and_then(file_name) {
            return parent;
        }
    }
    name.strip_suffix(".git").filter(|n| !n.is_empty()).unwrap_or(&name).to_string()
}

#[tauri::command]
async fn add_repo(state: State<'_, AppState>, path: String) -> Result<Repo, String> {
    let dir = Path::new(&path);
    // Bare repositories (including the `.bare` + worktrees layout) have no
    // top-level working tree, so they are identified by their git directory.
    let root = match git::git(dir, &["rev-parse", "--show-toplevel"]).await {
        Ok(root) => root,
        Err(_) => {
            let bare = git::git(dir, &["rev-parse", "--is-bare-repository"]).await;
            if bare.as_deref() != Ok("true") {
                return Err(format!("{path} is not a git repository"));
            }
            git::git(dir, &["rev-parse", "--absolute-git-dir"]).await?
        }
    };
    let mut store = state.store.lock().unwrap();
    if let Some(existing) = store.data.repos.iter().find(|r| r.path == root) {
        return Ok(existing.clone());
    }
    let name = repo_name(Path::new(&root));
    let repo = Repo { id: new_id(), name, path: root, run_script: None, setup_script: None };
    store.data.repos.push(repo.clone());
    store.save()?;
    Ok(repo)
}

#[tauri::command]
fn remove_repo(state: State<AppState>, repo_id: String) -> Result<(), String> {
    let mut store = state.store.lock().unwrap();
    if store.data.workspaces.iter().any(|w| w.repo_id == repo_id && !w.archived) {
        return Err("Archive this repository's workspaces first.".into());
    }
    store.data.repos.retain(|r| r.id != repo_id);
    store.save()
}

/// Creates a worktree on a fresh branch, off the repository's default branch
/// or, when forking, with the code exactly as it was at `from`.
pub(crate) async fn make_workspace(state: &AppState, repo_id: &str, from: Start) -> Result<Workspace, String> {
    let repo = {
        let store = state.store.lock().unwrap();
        store.data.repos.iter().find(|r| r.id == repo_id).cloned().ok_or("repository not found")?
    };
    let repo_path = PathBuf::from(&repo.path);
    let parent = productor_dir()?.join("workspaces").join(&repo.name);
    std::fs::create_dir_all(&parent).map_err(|e| e.to_string())?;

    let prefix = git::git(&repo_path, &["config", "user.name"])
        .await
        .ok()
        .and_then(|n| n.split_whitespace().next().map(|w| w.to_lowercase()))
        .filter(|w| w.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or_else(|| "productor".into());

    // A name is taken if its directory or its branch already exists, including
    // ones left behind by archived workspaces.
    let mut taken: Vec<String> = Vec::new();
    let name = loop {
        let name = pick_name(&taken);
        let branch_ref = format!("refs/heads/{prefix}/{name}");
        let branch_exists = git::git(&repo_path, &["rev-parse", "--verify", "--quiet", &branch_ref]).await.is_ok();
        if !branch_exists && !parent.join(&name).exists() {
            break name;
        }
        taken.push(name);
    };
    let branch = format!("{prefix}/{name}");
    let path = parent.join(&name);
    let path_str = path.to_string_lossy().to_string();

    let (base_sha, group_id) = match from {
        Start::Snapshot(from) => {
            // A snapshot is a commit whose parent is the HEAD of the time and
            // whose tree is the full working tree. Check out that HEAD, then
            // lay the snapshot's files over it as uncommitted changes, which
            // is what they were in the original worktree.
            let head = git::git(&repo_path, &["rev-parse", &format!("{}^", from.snapshot_sha)]).await?;
            git::git(&repo_path, &["worktree", "add", "--no-track", "-b", &branch, &path_str, &head]).await?;
            git::git(&path, &["read-tree", "--reset", "-u", &from.snapshot_sha]).await?;
            git::git(&path, &["reset", "--quiet"]).await?;
            (from.base_sha, from.group_id)
        }
        Start::Commit(sha) => {
            git::git(&repo_path, &["worktree", "add", "--no-track", "-b", &branch, &path_str, &sha]).await?;
            // The changes panel compares against where this commit left the
            // default branch, which is what the pull request changed.
            let default = git::default_base(&repo_path).await.unwrap_or_default();
            (git::git(&repo_path, &["merge-base", &sha, &default]).await.ok(), None)
        }
        Start::Default => {
            let base = fresh_base(&repo_path).await?;
            git::git(&repo_path, &["worktree", "add", "--no-track", "-b", &branch, &path_str, &base]).await?;
            (git::git(&repo_path, &["rev-parse", &base]).await.ok(), None)
        }
    };

    let workspace = Workspace {
        id: new_id(),
        repo_id: repo_id.to_string(),
        name,
        branch,
        path: path_str,
        created_at: now_ms(),
        archived: false,
        base_sha,
        group_id,
        auto_pr: false,
        ci_fix_sha: None,
        ci_fix_attempts: 0,
        handled_threads: Vec::new(),
        auto_push: false,
        conflict_sha: None,
        linked_pr: None,
    };
    let mut store = state.store.lock().unwrap();
    store.data.workspaces.push(workspace.clone());
    store.save()?;
    Ok(workspace)
}

/// Fetches and returns the ref or commit new work should start from.
///
/// Only the default branch is fetched. Fetching everything can take many
/// minutes on a repository with thousands of remote branches, and a stalled
/// fetch must not hold up creating a workspace, so it is also time-limited;
/// if it fails, work starts from what is already here.
async fn fresh_base(repo_path: &Path) -> Result<String, String> {
    let base = git::default_base(repo_path).await?;
    let branch = base.strip_prefix("origin/").unwrap_or(&base);
    let fetched = git::git_within(repo_path, &["fetch", "--quiet", "origin", branch], std::time::Duration::from_secs(90)).await;
    if let Err(e) = &fetched {
        eprintln!("could not refresh {branch}: {e}");
    }
    // Fetching a branch by name also updates its remote-tracking ref, so
    // `origin/<branch>` is now current. A bare clone has no such ref, and
    // its local branch is not moved by a fetch, so use what was fetched.
    if fetched.is_ok() && !base.starts_with("origin/") && is_bare(repo_path).await {
        if let Ok(sha) = git::git(repo_path, &["rev-parse", "FETCH_HEAD"]).await {
            return Ok(sha);
        }
    }
    Ok(base)
}

async fn is_bare(repo_path: &Path) -> bool {
    git::git(repo_path, &["rev-parse", "--is-bare-repository"]).await.as_deref() == Ok("true")
}

#[tauri::command]
async fn create_workspace(state: State<'_, AppState>, repo_id: String) -> Result<Value, String> {
    let workspace = make_workspace(&state, &repo_id, Start::Default).await?;
    let chat = Chat::new(Some(workspace.id.clone()), None, None);
    let mut store = state.store.lock().unwrap();
    store.data.chats.push(chat.clone());
    store.save()?;
    Ok(json!({ "workspace": workspace, "chat": chat }))
}

/// Opens a read-only chat against the repository's main checkout, with no
/// worktree to set up. A bare repository has no checkout, so its quick chats
/// share one detached worktree that is created on first use.
pub(crate) async fn make_quick_chat<R: Runtime>(app: &AppHandle<R>, repo_id: &str) -> Result<Chat, String> {
    let state = app.state::<AppState>();
    let repo = {
        let store = state.store.lock().unwrap();
        store.data.repos.iter().find(|r| r.id == repo_id).cloned().ok_or("repository not found")?
    };
    let repo_path = PathBuf::from(&repo.path);
    let cwd = if is_bare(&repo_path).await {
        let checkout = productor_dir()?.join("quick").join(&repo.name);
        let checkout_str = checkout.to_string_lossy().to_string();
        if !checkout.exists() {
            std::fs::create_dir_all(checkout.parent().unwrap()).map_err(|e| e.to_string())?;
            let base = git::default_base(&repo_path).await?;
            let _ = git::git(&repo_path, &["worktree", "prune"]).await;
            git::git(&repo_path, &["worktree", "add", "--detach", &checkout_str, &base]).await?;
        }
        // Bring the shared checkout up to date in the background, unless
        // another read-only chat is in the middle of reading it.
        let others_busy = {
            let store = state.store.lock().unwrap();
            store.data.chats.iter().any(|c| c.repo_id.as_deref() == Some(repo_id) && agent::is_busy(app, &c.id))
        };
        // One refresh per checkout at a time; opening several chats in a
        // row must not pile up fetches of the same repository.
        static REFRESHING: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
        let start = !others_busy && {
            let mut refreshing = REFRESHING.lock().unwrap();
            let free = !refreshing.contains(&checkout);
            if free {
                refreshing.push(checkout.clone());
            }
            free
        };
        if start {
            tauri::async_runtime::spawn(async move {
                if let Ok(base) = fresh_base(&repo_path).await {
                    let _ = git::git(&checkout, &["checkout", "--quiet", "--detach", &base]).await;
                }
                REFRESHING.lock().unwrap().retain(|path| path != &checkout);
            });
        }
        checkout_str
    } else {
        repo.path.clone()
    };

    let chat = Chat::new(None, Some(repo_id.to_string()), Some(cwd));
    let mut store = state.store.lock().unwrap();
    store.data.chats.push(chat.clone());
    store.save()?;
    Ok(chat)
}

#[tauri::command]
async fn create_quick_chat(app: AppHandle, repo_id: String) -> Result<Chat, String> {
    make_quick_chat(&app, &repo_id).await
}

/// Where Claude Code keeps the transcripts of sessions started in `cwd`.
fn claude_project_dir(cwd: &Path) -> Option<PathBuf> {
    let config = std::env::var("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|_| std::env::var("HOME").map(|home| PathBuf::from(home).join(".claude")))
        .ok()?;
    let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    let encoded: String = cwd
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    Some(config.join("projects").join(encoded))
}

/// Claude Code only resumes a session from the directory it was started in,
/// so continuing a chat elsewhere means copying its session transcript across.
fn copy_session(session_id: &str, from: &Path, to: &Path) -> Result<(), String> {
    let file = format!("{session_id}.jsonl");
    let source = claude_project_dir(from).ok_or("no Claude config directory")?.join(&file);
    let target_dir = claude_project_dir(to).ok_or("no Claude config directory")?;
    std::fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
    std::fs::copy(&source, target_dir.join(&file)).map_err(|e| format!("{}: {e}", source.display()))?;
    Ok(())
}

/// Turns a quick chat into a full workspace: a new worktree, with the
/// conversation carried over and the agent free to make changes.
#[tauri::command]
async fn promote_chat(app: AppHandle, state: State<'_, AppState>, chat_id: String) -> Result<Value, String> {
    let chat = state.store.lock().unwrap().chat(&chat_id).cloned().ok_or("chat not found")?;
    let repo_id = chat.repo_id.clone().ok_or("only quick chats can be promoted")?;
    if agent::is_busy(&app, &chat_id) {
        return Err("Wait for the agent to finish its turn, or stop it, before promoting.".into());
    }
    state.agents.stop(&chat_id);

    // A review is promoted onto the code it is reviewing: the pull request's
    // head, fetched now. If that cannot be had, the default branch will do.
    let mut start = Start::Default;
    if let Some(linked) = &chat.linked_pr {
        let repo_path = state.store.lock().unwrap().data.repos.iter().find(|r| r.id == repo_id).map(|r| r.path.clone());
        if let Some(repo_path) = repo_path {
            let pull = format!("pull/{}/head", linked.number);
            let fetched = git::git_within(Path::new(&repo_path), &["fetch", "--quiet", "origin", &pull], std::time::Duration::from_secs(90)).await;
            match fetched {
                Ok(_) => {
                    if let Ok(sha) = git::git(Path::new(&repo_path), &["rev-parse", "FETCH_HEAD"]).await {
                        start = Start::Commit(sha);
                    }
                }
                Err(e) => eprintln!("could not fetch pull request #{}: {e}", linked.number),
            }
        }
    }
    let on_pr_code = matches!(start, Start::Commit(_));
    let mut workspace = make_workspace(&state, &repo_id, start).await?;
    if let Some(linked) = &chat.linked_pr {
        workspace.linked_pr = Some(linked.clone());
        let mut store = state.store.lock().unwrap();
        if let Some(stored) = store.data.workspaces.iter_mut().find(|w| w.id == workspace.id) {
            stored.linked_pr = Some(linked.clone());
        }
        store.save()?;
    }
    let old_cwd = chat.cwd.clone().unwrap_or_default();
    let mut session_id = chat.session_id.clone();
    // Codex finds a thread by id from any directory; only Claude Code keeps
    // its sessions per directory.
    if let Some(id) = session_id.as_ref().filter(|_| chat.agent == "claude") {
        if let Err(e) = copy_session(id, Path::new(&old_cwd), Path::new(&workspace.path)) {
            eprintln!("could not carry session {id} over: {e}");
            session_id = None;
        }
    }
    let carried = session_id.is_some();

    let updated = {
        let mut store = state.store.lock().unwrap();
        let chat = store.chat_mut(&chat_id).ok_or("chat not found")?;
        chat.workspace_id = Some(workspace.id.clone());
        chat.repo_id = None;
        chat.cwd = None;
        chat.group_id = None;
        chat.session_id = session_id;
        chat.pending_note = carried.then(|| format!(
            "This conversation has moved from the read-only checkout at {old_cwd} to a new git worktree at {} \
             on branch {}. The same files are there at the same relative paths. You are no longer read-only: \
             you can now edit files and run commands in the new worktree.{}",
            workspace.path,
            workspace.branch,
            if on_pr_code { " The worktree holds the pull request's code, checked out at its latest commit." } else { "" }
        ));
        let updated = chat.clone();
        store.save()?;
        updated
    };
    agent::notice(&app, &chat_id, &format!("Promoted to workspace {} on {}", workspace.name, workspace.branch));
    if chat.session_id.is_some() && !carried {
        agent::notice(&app, &chat_id, "The earlier conversation could not be carried over, so the agent starts fresh here.");
    }
    Ok(json!({ "workspace": workspace, "chat": updated }))
}

#[tauri::command]
fn warm_up_chat(app: AppHandle, chat_id: String) {
    warm_up(&app, &chat_id);
}

/// Branches a chat off at the end of one of its turns. With `with_worktree`,
/// the fork also gets its own workspace holding the code as it was then, so
/// both lines of work can carry on independently.
#[tauri::command]
async fn fork_chat(app: AppHandle, chat_id: String, turn: u32, with_worktree: bool) -> Result<Value, String> {
    fork::fork_chat(&app, &chat_id, turn, with_worktree).await
}

#[tauri::command]
fn create_group(state: State<AppState>, name: String) -> Result<Group, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("A group needs a name.".into());
    }
    let group = Group { id: new_id(), name };
    let mut store = state.store.lock().unwrap();
    store.data.groups.push(group.clone());
    store.save()?;
    Ok(group)
}

#[tauri::command]
fn rename_group(state: State<AppState>, group_id: String, name: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("A group needs a name.".into());
    }
    let mut store = state.store.lock().unwrap();
    let group = store.data.groups.iter_mut().find(|g| g.id == group_id).ok_or("group not found")?;
    group.name = name;
    store.save()
}

/// Deletes the group only; its members go back to being ungrouped.
#[tauri::command]
fn delete_group(state: State<AppState>, group_id: String) -> Result<(), String> {
    let mut store = state.store.lock().unwrap();
    store.data.groups.retain(|g| g.id != group_id);
    for ws in store.data.workspaces.iter_mut().filter(|w| w.group_id.as_deref() == Some(&group_id)) {
        ws.group_id = None;
    }
    for chat in store.data.chats.iter_mut().filter(|c| c.group_id.as_deref() == Some(&group_id)) {
        chat.group_id = None;
    }
    store.save()
}

/// Moves a workspace or a quick chat into a group, or out of any group.
#[tauri::command]
fn set_group(
    state: State<AppState>,
    workspace_id: Option<String>,
    chat_id: Option<String>,
    group_id: Option<String>,
) -> Result<(), String> {
    let mut store = state.store.lock().unwrap();
    if let Some(id) = &group_id {
        if !store.data.groups.iter().any(|g| &g.id == id) {
            return Err("group not found".into());
        }
    }
    if let Some(id) = workspace_id {
        let ws = store.data.workspaces.iter_mut().find(|w| w.id == id).ok_or("workspace not found")?;
        ws.group_id = group_id;
    } else if let Some(id) = chat_id {
        let chat = store.chat_mut(&id).ok_or("chat not found")?;
        chat.group_id = group_id;
    }
    store.save()
}

/// Chooses which agent runs a chat. Only possible before the conversation
/// starts, since the agents cannot read each other's sessions.
#[tauri::command]
fn set_chat_agent(app: AppHandle, state: State<AppState>, chat_id: String, agent: String) -> Result<(), String> {
    if agent != "claude" && agent != "codex" {
        return Err(format!("unknown agent: {agent}"));
    }
    state.agents.stop(&chat_id);
    {
        let mut store = state.store.lock().unwrap();
        let chat = store.chat_mut(&chat_id).ok_or("chat not found")?;
        if chat.turns > 0 || chat.title.is_some() || chat.fork.is_some() {
            return Err("The agent can only be changed before the first message.".into());
        }
        chat.agent = agent;
        chat.session_id = None;
        store.save()?;
    }
    warm_up(&app, &chat_id);
    Ok(())
}

/// Changes the name a workspace is shown under. Its branch and its
/// directory keep their names, so nothing running in it is disturbed.
#[tauri::command]
fn rename_workspace(state: State<AppState>, workspace_id: String, name: String) -> Result<(), String> {
    let name: String = name.trim().chars().take(80).collect();
    if name.is_empty() {
        return Err("A workspace needs a name.".into());
    }
    let mut store = state.store.lock().unwrap();
    let ws = store.data.workspaces.iter_mut().find(|w| w.id == workspace_id).ok_or("workspace not found")?;
    ws.name = name;
    store.save()
}

#[tauri::command]
fn rename_chat(state: State<AppState>, chat_id: String, title: String) -> Result<(), String> {
    let title: String = title.trim().chars().take(120).collect();
    if title.is_empty() {
        return Err("A chat needs a name.".into());
    }
    let mut store = state.store.lock().unwrap();
    store.chat_mut(&chat_id).ok_or("chat not found")?.title = Some(title);
    store.save()
}

/// Chooses a chat's model and whether it runs in fast mode. Unlike the
/// agent itself, these can change at any point between turns.
#[tauri::command]
fn set_chat_options(app: AppHandle, state: State<AppState>, chat_id: String, model: Option<String>, fast: Option<bool>) -> Result<(), String> {
    if agent::is_busy(&app, &chat_id) {
        return Err("Wait for the agent to finish its turn before changing the model.".into());
    }
    {
        let mut store = state.store.lock().unwrap();
        let chat = store.chat_mut(&chat_id).ok_or("chat not found")?;
        chat.model = model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
        chat.fast = fast;
        store.save()?;
    }
    // Claude Code takes these when its process starts, so the next message
    // has to start a new one. The conversation resumes from its session.
    state.agents.stop(&chat_id);
    warm_up(&app, &chat_id);
    Ok(())
}

/// What each agent uses when a chat does not choose: read from the agents'
/// own configuration files so the picker can show what "default" means.
#[tauri::command]
fn agent_defaults() -> Value {
    let home = std::env::var("HOME").unwrap_or_default();
    let claude: Value = std::fs::read_to_string(format!("{home}/.claude/settings.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    // Top-level `key = "value"` lines are all that is needed from Codex's TOML.
    let codex = std::fs::read_to_string(format!("{home}/.codex/config.toml")).unwrap_or_default();
    let codex_value = |key: &str| {
        codex.lines().take_while(|line| !line.trim_start().starts_with('[')).find_map(|line| {
            let (name, value) = line.split_once('=')?;
            (name.trim() == key).then(|| value.trim().trim_matches('"').to_string())
        })
    };
    json!({
        "claudeModel": claude["model"].as_str(),
        "codexModel": codex_value("model"),
        "codexFast": codex_value("service_tier").as_deref() == Some("fast"),
    })
}

/// Starts a quick chat's Claude Code process ahead of the first question, so
/// that question does not wait on startup. Codex runs one process per turn
/// and has nothing to warm up.
fn warm_up(app: &AppHandle, chat_id: &str) {
    let state = app.state::<AppState>();
    let wanted = state
        .store
        .lock()
        .unwrap()
        .chat(chat_id)
        .is_some_and(|c| c.agent == "claude" && c.workspace_id.is_none());
    if wanted {
        let _ = agent::start(app, chat_id);
    }
}

/// Marks one inbox item as read, or all of them when no id is given.
#[tauri::command]
fn mark_inbox_read(state: State<AppState>, item_id: Option<String>) -> Result<(), String> {
    let mut store = state.store.lock().unwrap();
    for item in store.data.inbox.iter_mut() {
        if item_id.as_ref().is_none_or(|id| &item.id == id) {
            item.read = true;
        }
    }
    store.save()
}

/// Removes an item from the inbox, along with the review chat started from
/// it. The item is kept, hidden, so the next check of GitHub does not put a
/// still-pending request straight back.
#[tauri::command]
fn delete_inbox_item(state: State<AppState>, item_id: String) -> Result<(), String> {
    let mut store = state.store.lock().unwrap();
    let Some(item) = store.data.inbox.iter_mut().find(|i| i.id == item_id) else { return Ok(()) };
    item.dismissed = true;
    item.read = true;
    if let Some(chat_id) = item.chat_id.take() {
        // A review that was promoted now belongs to its workspace and stays
        // there; only a read-only review chat goes with its inbox item.
        if store.chat(&chat_id).is_some_and(|c| c.workspace_id.is_none()) {
            state.agents.stop(&chat_id);
            store.data.chats.retain(|c| c.id != chat_id);
            store.delete_events(&chat_id);
        }
    }
    store.save()
}

/// Has an agent review the pull request behind an inbox item, read-only.
#[tauri::command]
async fn start_review(app: AppHandle, item_id: String) -> Result<String, String> {
    inbox::start_review(&app, &item_id).await
}

/// Checks GitHub for review requests now instead of waiting for the next poll.
#[tauri::command]
async fn refresh_inbox(app: AppHandle) -> Result<(), String> {
    inbox::sync(&app).await
}

/// The user's own open pull requests on GitHub.
#[tauri::command]
async fn my_pull_requests() -> Result<Vec<Value>, String> {
    inbox::my_pull_requests().await
}

/// Opens one of the user's pull requests as a workspace: a worktree on the
/// pull request's branch, so its agent can fix CI, answer reviews and push.
#[tauri::command]
async fn open_pr_workspace(state: State<'_, AppState>, repo: String, number: i64) -> Result<Value, String> {
    let slug = repo.to_lowercase();
    let repos = state.store.lock().unwrap().data.repos.clone();
    let mut found = None;
    for candidate in &repos {
        let remote = git::git(Path::new(&candidate.path), &["remote", "get-url", "origin"]).await.unwrap_or_default();
        if inbox::repo_slug(&remote).is_some_and(|s| s.to_lowercase() == slug) {
            found = Some(candidate.clone());
            break;
        }
    }
    let repo = found.ok_or(format!("Add {slug} to Productor to open its pull requests here."))?;
    let repo_path = PathBuf::from(&repo.path);

    let number_arg = number.to_string();
    let pr = pr::gh(&repo_path, &["pr", "view", &number_arg, "--repo", &slug, "--json", "headRefName,isCrossRepository,title"]).await?;
    if pr["isCrossRepository"] == true {
        return Err("That pull request comes from a fork, which Productor cannot push to.".into());
    }
    let head = pr["headRefName"].as_str().ok_or("GitHub did not say which branch the pull request is on.")?.to_string();
    let title = pr["title"].as_str().unwrap_or("").to_string();

    // Already open? Then that workspace is the answer.
    let fallback = format!("{head}-productor");
    let existing = {
        let store = state.store.lock().unwrap();
        store
            .data
            .workspaces
            .iter()
            .find(|w| !w.archived && w.repo_id == repo.id && (w.branch == head || w.branch == fallback) && w.linked_pr.is_none())
            .cloned()
    };
    if let Some(workspace) = existing {
        return Ok(json!({ "workspace": workspace, "chat": Value::Null }));
    }

    git::git_within(&repo_path, &["fetch", "--quiet", "origin", &head], std::time::Duration::from_secs(120)).await?;
    let tip = match git::git(&repo_path, &["rev-parse", "--verify", "--quiet", &format!("origin/{head}")]).await {
        Ok(sha) => sha,
        Err(_) => git::git(&repo_path, &["rev-parse", "FETCH_HEAD"]).await?,
    };

    // Use the pull request's own branch name when it is free. Git allows a
    // branch in only one worktree, so if it is checked out somewhere else
    // (the main clone, say) this workspace gets a branch of its own that
    // tracks and pushes to the same remote branch.
    let worktrees = git::git(&repo_path, &["worktree", "list", "--porcelain"]).await.unwrap_or_default();
    let checked_out = |branch: &str| worktrees.lines().any(|line| line == format!("branch refs/heads/{branch}"));
    let exists = git::git(&repo_path, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{head}")]).await.is_ok();
    let branch = if checked_out(&head) { fallback.clone() } else { head.clone() };
    if checked_out(&branch) {
        return Err(format!("Both {head} and {fallback} are checked out in other worktrees."));
    }

    let parent = productor_dir()?.join("workspaces").join(&repo.name);
    std::fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
    let mut taken: Vec<String> = Vec::new();
    let dir = loop {
        let name = pick_name(&taken);
        if !parent.join(&name).exists() {
            break name;
        }
        taken.push(name);
    };
    let path = parent.join(&dir);
    let path_str = path.to_string_lossy().to_string();
    if branch == head && exists {
        // The local branch may be behind what was just fetched.
        git::git(&repo_path, &["worktree", "add", &path_str, &branch]).await?;
        let _ = git::git(&path, &["merge", "--ff-only", "--quiet", &tip]).await;
    } else {
        git::git(&repo_path, &["worktree", "add", "--no-track", "-B", &branch, &path_str, &tip]).await?;
    }
    let _ = git::git(&repo_path, &["config", &format!("branch.{branch}.remote"), "origin"]).await;
    let _ = git::git(&repo_path, &["config", &format!("branch.{branch}.merge"), &format!("refs/heads/{head}")]).await;

    let default = git::default_base(&repo_path).await.unwrap_or_default();
    let workspace = Workspace {
        id: new_id(),
        repo_id: repo.id.clone(),
        name: format!("#{number} {title}").chars().take(48).collect(),
        branch: branch.clone(),
        path: path_str,
        created_at: now_ms(),
        archived: false,
        base_sha: git::git(&repo_path, &["merge-base", &tip, &default]).await.ok(),
        group_id: None,
        auto_pr: false,
        ci_fix_sha: None,
        ci_fix_attempts: 0,
        handled_threads: Vec::new(),
        auto_push: false,
        conflict_sha: None,
        linked_pr: None,
    };
    let mut chat = Chat::new(Some(workspace.id.clone()), None, None);
    if branch != head {
        chat.pending_note = Some(format!(
            "This worktree is on the local branch {branch}, which tracks the pull request's branch {head}. \
             To push, use `git push origin HEAD:{head}`."
        ));
    }
    let mut store = state.store.lock().unwrap();
    store.data.workspaces.push(workspace.clone());
    store.data.chats.push(chat.clone());
    store.save()?;
    Ok(json!({ "workspace": workspace, "chat": chat }))
}

/// Lets a workspace's agent push to its own branch without asking each time.
#[tauri::command]
fn set_auto_push(state: State<AppState>, workspace_id: String, enabled: bool) -> Result<(), String> {
    let mut store = state.store.lock().unwrap();
    let ws = store.data.workspaces.iter_mut().find(|w| w.id == workspace_id).ok_or("workspace not found")?;
    ws.auto_push = enabled;
    store.save()
}

/// Whether the tools Productor drives are installed and logged in.
#[tauri::command]
async fn health() -> Vec<Value> {
    async fn check(name: &str, program: &str, args: &[&str], fix: &str) -> Value {
        let mut command = tokio::process::Command::new(program);
        command.args(args).kill_on_drop(true);
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(15), command.output()).await;
        let (ok, detail) = match outcome {
            Ok(Ok(out)) => {
                // `gh auth status` reports on stderr; the others on stdout.
                let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
                let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string();
                (out.status.success(), line)
            }
            Ok(Err(_)) => (false, format!("{program} was not found on your PATH.")),
            Err(_) => (false, format!("{program} did not answer in time.")),
        };
        json!({ "name": name, "ok": ok, "detail": detail, "fix": if ok { "" } else { fix } })
    }
    vec![
        check("Git", "git", &["--version"], "Install the Xcode command line tools: xcode-select --install").await,
        check("Claude Code", "claude", &["--version"], "Install Claude Code and run `claude` once to log in.").await,
        check("Codex", "codex", &["login", "status"], "Only needed for Codex chats: install Codex and run `codex login`.").await,
        check("GitHub CLI", "gh", &["auth", "status"], "Needed for the inbox and pull requests: install gh and run `gh auth login`.").await,
    ]
}

/// How much disk each workspace and shared checkout takes, in kilobytes.
#[tauri::command]
async fn storage(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let mut places: Vec<(Option<String>, String, String)> = {
        let store = state.store.lock().unwrap();
        store.data.workspaces.iter().filter(|w| !w.archived).map(|w| (Some(w.id.clone()), w.name.clone(), w.path.clone())).collect()
    };
    if let Ok(entries) = std::fs::read_dir(productor_dir()?.join("quick")) {
        for entry in entries.flatten() {
            let name = format!("{} (shared read-only checkout)", entry.file_name().to_string_lossy());
            places.push((None, name, entry.path().to_string_lossy().to_string()));
        }
    }
    let mut sizes = Vec::new();
    for (id, name, path) in places {
        let out = tokio::process::Command::new("du").args(["-sk", &path]).output().await.map_err(|e| e.to_string())?;
        let kb = String::from_utf8_lossy(&out.stdout).split_whitespace().next().and_then(|n| n.parse::<u64>().ok()).unwrap_or(0);
        sizes.push(json!({ "workspaceId": id, "name": name, "path": path, "kb": kb }));
    }
    sizes.sort_by_key(|s| std::cmp::Reverse(s["kb"].as_u64().unwrap_or(0)));
    Ok(sizes)
}

/// Re-reads a workspace's pull request from GitHub now.
#[tauri::command]
async fn refresh_pr(app: AppHandle, workspace_id: String) -> Result<(), String> {
    pr::refresh(&app, &workspace_id).await
}

/// Asks a workspace's agent to open its pull request, fix its CI, or
/// address its review comments.
#[tauri::command]
fn pr_action(app: AppHandle, workspace_id: String, chat_id: Option<String>, action: String) -> Result<(), String> {
    pr::act(&app, &workspace_id, chat_id, &action)
}

/// Turns on or off the agent looking after a workspace's pull request unasked.
#[tauri::command]
async fn set_auto_pr(app: AppHandle, state: State<'_, AppState>, workspace_id: String, enabled: bool) -> Result<(), String> {
    {
        let mut store = state.store.lock().unwrap();
        let ws = store.data.workspaces.iter_mut().find(|w| w.id == workspace_id).ok_or("workspace not found")?;
        ws.auto_pr = enabled;
        if enabled {
            ws.ci_fix_attempts = 0;
        }
        store.save()?;
    }
    // Act on whatever state the pull request is in right now.
    pr::refresh(&app, &workspace_id).await
}

/// Squash-merges every ready pull request in a group; returns what happened to each.
#[tauri::command]
async fn merge_group(app: AppHandle, group_id: String) -> Result<Vec<String>, String> {
    pr::merge_group(&app, &group_id).await
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !["https://", "http://", "mailto:"].iter().any(|scheme| url.starts_with(scheme)) {
        return Err("Only web and mail links can be opened.".into());
    }
    std::process::Command::new("open").arg(&url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_chat(state: State<AppState>, chat_id: String) -> Result<(), String> {
    state.agents.stop(&chat_id);
    let mut store = state.store.lock().unwrap();
    store.data.chats.retain(|c| c.id != chat_id);
    store.delete_events(&chat_id);
    store.save()
}

fn archive_ref(workspace_id: &str) -> String {
    format!("refs/productor/archive/{workspace_id}")
}

/// Brings an archived workspace back: its worktree on its branch, with any
/// uncommitted work it had when it was archived.
#[tauri::command]
async fn restore_workspace(state: State<'_, AppState>, workspace_id: String) -> Result<(), String> {
    let (workspace, repo_path) = {
        let store = state.store.lock().unwrap();
        let ws = store.workspace(&workspace_id).cloned().ok_or("workspace not found")?;
        let repo = store.data.repos.iter().find(|r| r.id == ws.repo_id).map(|r| r.path.clone());
        (ws, repo.ok_or("This workspace's repository is no longer in Productor.")?)
    };
    if !workspace.archived {
        return Ok(());
    }
    let repo_path = Path::new(&repo_path);
    let path = Path::new(&workspace.path);
    if path.exists() {
        return Err(format!("{} already exists.", workspace.path));
    }
    let _ = git::git(repo_path, &["worktree", "prune"]).await;
    git::git(repo_path, &["worktree", "add", &workspace.path, &workspace.branch]).await?;
    // Lay the archived working tree back over the branch, provided the
    // branch has not moved since; otherwise the committed state stands.
    let saved = archive_ref(&workspace_id);
    let head = git::git(path, &["rev-parse", "HEAD"]).await?;
    if git::git(repo_path, &["rev-parse", &format!("{saved}^")]).await.ok().as_deref() == Some(head.as_str()) {
        git::git(path, &["read-tree", "--reset", "-u", &saved]).await?;
        git::git(path, &["reset", "--quiet"]).await?;
    }
    let mut store = state.store.lock().unwrap();
    if let Some(ws) = store.data.workspaces.iter_mut().find(|w| w.id == workspace_id) {
        ws.archived = false;
    }
    store.save()
}

/// Removes the worktree from disk. The branch and per-turn snapshots stay in
/// the repository, so nothing committed or snapshotted is lost.
#[tauri::command]
async fn archive_workspace(state: State<'_, AppState>, workspace_id: String) -> Result<(), String> {
    let (workspace, repo_path, chat_ids) = {
        let store = state.store.lock().unwrap();
        let ws = store.workspace(&workspace_id).cloned().ok_or("workspace not found")?;
        let repo = store.data.repos.iter().find(|r| r.id == ws.repo_id).map(|r| r.path.clone());
        let chats: Vec<String> = store
            .data
            .chats
            .iter()
            .filter(|c| c.workspace_id.as_deref() == Some(&workspace_id))
            .map(|c| c.id.clone())
            .collect();
        (ws, repo, chats)
    };
    for id in &chat_ids {
        state.agents.stop(id);
    }
    state.terminals.close_workspace(&workspace_id);
    if let Some(repo_path) = repo_path {
        if Path::new(&workspace.path).exists() {
            // Keep the working tree as it stands, uncommitted work included,
            // so the workspace can be restored exactly.
            let _ = git::snapshot(Path::new(&workspace.path), &archive_ref(&workspace_id)).await;
            git::git(Path::new(&repo_path), &["worktree", "remove", "--force", &workspace.path]).await?;
        } else {
            let _ = git::git(Path::new(&repo_path), &["worktree", "prune"]).await;
        }
    }
    let mut store = state.store.lock().unwrap();
    if let Some(ws) = store.data.workspaces.iter_mut().find(|w| w.id == workspace_id) {
        ws.archived = true;
    }
    store.save()
}

#[tauri::command]
fn create_chat(state: State<AppState>, workspace_id: String) -> Result<Chat, String> {
    let mut store = state.store.lock().unwrap();
    store.workspace(&workspace_id).ok_or("workspace not found")?;
    let chat = Chat::new(Some(workspace_id), None, None);
    store.data.chats.push(chat.clone());
    store.save()?;
    Ok(chat)
}

#[tauri::command]
fn get_transcript(state: State<AppState>, chat_id: String) -> Vec<Value> {
    state.store.lock().unwrap().read_events(&chat_id)
}

#[tauri::command]
async fn send_message(app: AppHandle, chat_id: String, text: String, attachments: Option<Vec<String>>) -> Result<(), String> {
    agent::send_message_with(&app, &chat_id, &text, &attachments.unwrap_or_default())
}

/// Stores a file pasted or dropped into the composer, and returns where it
/// was put so it can be attached to a message.
#[tauri::command]
fn save_attachment(state: State<AppState>, name: String, data: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
    // Keep only a plain file name; it is used as part of a path.
    let safe: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')).collect();
    let safe = if safe.trim_matches('.').is_empty() { "file".to_string() } else { safe };
    let dir = state.store.lock().unwrap().attachments_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}-{safe}", &new_id()[..8]));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// The files of the directory a chat works in, for `@` mentions.
#[tauri::command]
async fn list_chat_files(state: State<'_, AppState>, chat_id: String) -> Result<Vec<String>, String> {
    let cwd = {
        let store = state.store.lock().unwrap();
        let chat = store.chat(&chat_id).ok_or("chat not found")?;
        match &chat.workspace_id {
            Some(id) => store.workspace(id).map(|w| w.path.clone()),
            None => chat.cwd.clone(),
        }
        .ok_or("chat has no directory")?
    };
    files::list(Path::new(&cwd)).await
}

/// Answers a question the agent put to the user.
#[tauri::command]
fn answer_question(app: AppHandle, chat_id: String, request_id: String, answers: Value) -> Result<(), String> {
    agent::answer_question(&app, &chat_id, &request_id, answers)
}

/// Turns plan mode on or off for a chat: in it, the agent proposes a plan
/// and waits for approval before changing anything.
#[tauri::command]
fn set_chat_plan(app: AppHandle, state: State<AppState>, chat_id: String, plan: bool) -> Result<(), String> {
    if agent::is_busy(&app, &chat_id) {
        return Err("Wait for the agent to finish its turn before changing plan mode.".into());
    }
    {
        let mut store = state.store.lock().unwrap();
        store.chat_mut(&chat_id).ok_or("chat not found")?.plan = plan;
        store.save()?;
    }
    // The mode is set when the process starts.
    state.agents.stop(&chat_id);
    Ok(())
}

/// Finds chats whose messages contain `query`, newest chats first.
#[tauri::command]
fn search_chats(state: State<AppState>, query: String) -> Vec<Value> {
    let needle = query.trim().to_lowercase();
    let mut hits = Vec::new();
    if needle.len() < 2 {
        return hits;
    }
    let store = state.store.lock().unwrap();
    let mut chats: Vec<&Chat> = store.data.chats.iter().collect();
    chats.sort_by_key(|c| std::cmp::Reverse(c.created_at));
    for chat in chats {
        for event in store.read_events(&chat.id) {
            let (who, text) = match event["type"].as_str() {
                Some("productor_user") => ("you", event["text"].as_str().unwrap_or("").to_string()),
                Some("assistant") if event["parent_tool_use_id"].is_null() => {
                    let text: Vec<&str> = event["message"]["content"]
                        .as_array()
                        .map(|blocks| blocks.iter().filter_map(|b| b["text"].as_str()).collect())
                        .unwrap_or_default();
                    ("agent", text.join("\n"))
                }
                _ => continue,
            };
            let lower = text.to_lowercase();
            let Some(at) = lower.find(&needle) else { continue };
            // Cut a window around the match, on character boundaries.
            let start = lower[..at].char_indices().rev().nth(50).map_or(0, |(i, _)| i);
            let end = lower[at..].char_indices().nth(needle.chars().count() + 90).map_or(lower.len(), |(i, _)| at + i);
            let snippet = text.get(start..end).unwrap_or(&text).replace('\n', " ");
            hits.push(json!({ "chatId": chat.id, "who": who, "snippet": snippet }));
            if hits.len() >= 60 {
                return hits;
            }
            // One hit per chat is enough to find it.
            break;
        }
    }
    hits
}

#[tauri::command]
fn interrupt(app: AppHandle, chat_id: String) {
    agent::interrupt(&app, &chat_id);
}

#[tauri::command]
fn respond_permission(app: AppHandle, chat_id: String, request_id: String, allow: bool) -> Result<(), String> {
    agent::respond_permission(&app, &chat_id, &request_id, allow)
}

#[tauri::command]
fn set_run_script(state: State<AppState>, repo_id: String, script: Option<String>) -> Result<(), String> {
    let mut store = state.store.lock().unwrap();
    let repo = store.data.repos.iter_mut().find(|r| r.id == repo_id).ok_or("repository not found")?;
    repo.run_script = script.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    store.save()
}

#[tauri::command]
fn set_setup_script(state: State<AppState>, repo_id: String, script: Option<String>) -> Result<(), String> {
    let mut store = state.store.lock().unwrap();
    let repo = store.data.repos.iter_mut().find(|r| r.id == repo_id).ok_or("repository not found")?;
    repo.setup_script = script.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    store.save()
}

#[tauri::command]
fn set_settings(state: State<AppState>, settings: store::Settings) -> Result<(), String> {
    let mut store = state.store.lock().unwrap();
    let restart_agents = store.data.settings.use_api_key != settings.use_api_key;
    store.data.settings = settings;
    store.data.settings.editor = store.data.settings.editor.trim().to_string();
    store.save()?;
    drop(store);
    // Which login Claude Code uses is fixed when its process starts.
    if restart_agents {
        state.agents.reap_idle(std::time::Duration::ZERO);
    }
    Ok(())
}

/// Opens a workspace's folder in the user's editor or in Finder.
#[tauri::command]
fn open_workspace(state: State<AppState>, workspace_id: String, with: String) -> Result<(), String> {
    let (path, editor) = {
        let store = state.store.lock().unwrap();
        let ws = store.workspace(&workspace_id).ok_or("workspace not found")?;
        (ws.path.clone(), store.data.settings.editor.clone())
    };
    let spawned = if with == "finder" {
        std::process::Command::new("open").arg(&path).spawn()
    } else {
        if editor.is_empty() {
            return Err("Choose an editor command in Settings first.".into());
        }
        // Through a login shell, so the editor's command-line launcher is
        // found the same way it is in a terminal. The path is passed as an
        // argument, never spliced into the command.
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        std::process::Command::new(shell).args(["-lic", &format!("{editor} \"$1\""), "productor", &path]).spawn()
    };
    spawned.map(|_| ()).map_err(|e| e.to_string())
}

/// Commits everything in the workspace's worktree.
#[tauri::command]
async fn commit_workspace(state: State<'_, AppState>, workspace_id: String, message: String) -> Result<(), String> {
    let path = workspace_path(&state, &workspace_id)?;
    if message.trim().is_empty() {
        return Err("A commit needs a message.".into());
    }
    git::git(&path, &["add", "-A"]).await?;
    git::git(&path, &["commit", "-m", message.trim()]).await.map(|_| ())
}

/// Pushes the workspace's branch, setting its upstream on the first push.
#[tauri::command]
async fn push_workspace(app: AppHandle, state: State<'_, AppState>, workspace_id: String) -> Result<(), String> {
    let path = workspace_path(&state, &workspace_id)?;
    let branch = git::git(&path, &["branch", "--show-current"]).await?;
    // A workspace opened on an existing pull request may be on a local
    // branch named differently from the one it pushes to.
    let upstream = git::git(&path, &["config", &format!("branch.{branch}.merge")]).await.ok();
    let limit = std::time::Duration::from_secs(180);
    match upstream {
        Some(target) => git::git_within(&path, &["push", "origin", &format!("HEAD:{target}")], limit).await?,
        None => git::git_within(&path, &["push", "-u", "origin", &branch], limit).await?,
    };
    let _ = pr::refresh(&app, &workspace_id).await;
    Ok(())
}

/// Throws away a file's uncommitted changes, or deletes it if it was never
/// committed.
#[tauri::command]
async fn discard_file(state: State<'_, AppState>, workspace_id: String, path: String) -> Result<(), String> {
    let root = workspace_path(&state, &workspace_id)?;
    let tracked = git::git(&root, &["cat-file", "-e", &format!("HEAD:{path}")]).await.is_ok();
    if tracked {
        git::git(&root, &["restore", "--source=HEAD", "--staged", "--worktree", "--", &path]).await.map(|_| ())
    } else {
        let _ = git::git(&root, &["rm", "--cached", "--quiet", "--force", "--", &path]).await;
        files::remove(&root, &path).await
    }
}

fn workspace_path(state: &State<'_, AppState>, workspace_id: &str) -> Result<PathBuf, String> {
    let store = state.store.lock().unwrap();
    let ws = store.workspace(workspace_id).ok_or("workspace not found")?;
    Ok(PathBuf::from(&ws.path))
}

/// Everything the workspace has changed since it branched off, committed or
/// not, as one unified diff.
#[tauri::command]
async fn get_diff(state: State<'_, AppState>, workspace_id: String) -> Result<Value, String> {
    let (path, base_sha, repo_path) = {
        let store = state.store.lock().unwrap();
        let ws = store.workspace(&workspace_id).ok_or("workspace not found")?;
        let repo = store.data.repos.iter().find(|r| r.id == ws.repo_id).map(|r| r.path.clone());
        (PathBuf::from(&ws.path), ws.base_sha.clone(), repo)
    };
    // Prefer the remote default branch so a workspace rebased onto newer
    // upstream does not show upstream's changes as its own.
    let mut target = base_sha;
    if let Some(repo_path) = repo_path {
        if let Ok(default) = git::default_base(Path::new(&repo_path)).await {
            if default.starts_with("origin/") || target.is_none() {
                target = Some(default);
            }
        }
    }
    let target = target.ok_or("could not determine the base branch")?;
    let base = git::git(&path, &["merge-base", "HEAD", &target]).await?;
    let tree = git::worktree_tree(&path).await?;
    let diff = git::git_raw(&path, &["diff", "--no-color", "--no-ext-diff", "-M", &base, &tree], &[]).await?;
    // Files with uncommitted changes, and how far the branch is ahead of
    // what was last pushed (null if it never was).
    let status = git::git_raw(&path, &["status", "--porcelain", "-z", "--untracked-files=all"], &[]).await.unwrap_or_default();
    let uncommitted: Vec<&str> = status.split('\0').filter(|entry| entry.len() > 3).map(|entry| &entry[3..]).collect();
    let unpushed = git::git(&path, &["rev-list", "--count", "@{upstream}..HEAD"]).await.ok().and_then(|n| n.parse::<u32>().ok());
    Ok(json!({ "base": base, "diff": diff, "uncommitted": uncommitted, "unpushed": unpushed }))
}

#[tauri::command]
async fn list_files(state: State<'_, AppState>, workspace_id: String) -> Result<Vec<String>, String> {
    files::list(&workspace_path(&state, &workspace_id)?).await
}

#[tauri::command]
async fn read_file(state: State<'_, AppState>, workspace_id: String, path: String) -> Result<String, String> {
    files::read(&workspace_path(&state, &workspace_id)?, &path).await
}

#[tauri::command]
async fn write_file(state: State<'_, AppState>, workspace_id: String, path: String, content: String) -> Result<(), String> {
    files::write(&workspace_path(&state, &workspace_id)?, &path, &content).await
}

#[tauri::command]
fn term_open(
    app: AppHandle,
    state: State<AppState>,
    workspace_id: String,
    cols: u16,
    rows: u16,
    command: Option<String>,
) -> Result<String, String> {
    let cwd = workspace_path(&state, &workspace_id)?;
    // Scripts can reach the main repository through this, for example to
    // copy an untracked .env into a new worktree.
    let repo = {
        let store = state.store.lock().unwrap();
        let repo_id = store.workspace(&workspace_id).map(|w| w.repo_id.clone());
        store.data.repos.iter().find(|r| Some(&r.id) == repo_id.as_ref()).map(|r| r.path.clone()).unwrap_or_default()
    };
    state.terminals.open(&app, &workspace_id, &cwd, cols, rows, command, &[("PRODUCTOR_REPO", repo)])
}

#[tauri::command]
fn term_write(state: State<AppState>, id: String, data: String) -> Result<(), String> {
    state.terminals.write(&id, &data)
}

#[tauri::command]
fn term_resize(state: State<AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    state.terminals.resize(&id, cols, rows)
}

#[tauri::command]
fn term_close(state: State<AppState>, id: String) {
    state.terminals.close(&id);
}

/// Apps launched from Finder get a minimal PATH, so `claude` and `git` from
/// Homebrew or a version manager would not be found. Borrow the login shell's.
fn inherit_shell_path() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let output = std::process::Command::new(shell)
        .args(["-lic", "printf '__PATH__%s__PATH__' \"$PATH\""])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output();
    if let Ok(output) = output {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some(path) = stdout.split("__PATH__").nth(1) {
            if !path.is_empty() {
                std::env::set_var("PATH", path);
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    inherit_shell_path();
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let app = tauri::Builder::default()
        // Two copies would both write the same state and run the same agents;
        // a second launch brings the first one forward instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .on_window_event(|window, event| {
            // Closing the window quits the app and stops its agents mid-turn,
            // so check first when any are working.
            let tauri::WindowEvent::CloseRequested { api, .. } = event else { return };
            let Some(state) = window.app_handle().try_state::<AppState>() else { return };
            let busy = state.agents.statuses().values().filter(|status| *status != "idle").count();
            if busy == 0 {
                return;
            }
            api.prevent_close();
            let window = window.clone();
            window
                .app_handle()
                .dialog()
                .message(format!(
                    "{busy} agent{} still working. Quitting stops {} mid-turn; you can retry the turn afterwards.",
                    if busy == 1 { " is" } else { "s are" },
                    if busy == 1 { "it" } else { "them" },
                ))
                .title("Quit Productor?")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom("Quit".into(), "Keep running".into()))
                .show(move |quit| {
                    if quit {
                        let _ = window.destroy();
                    }
                });
        })
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let store = Store::load(dir);
            store.mark_interrupted();
            app.manage(AppState {
                store: Mutex::new(store),
                agents: Agents::default(),
                terminals: terminal::Terminals::default(),
                prs: pr::PrState::default(),
                problems: Default::default(),
            });
            inbox::start(app.handle().clone());
            pr::start(app.handle().clone());
            // Shut down agent processes that have sat unused for a while.
            let reaper = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    reaper.state::<AppState>().agents.reap_idle(std::time::Duration::from_secs(15 * 60));
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            add_repo,
            remove_repo,
            create_workspace,
            create_quick_chat,
            promote_chat,
            delete_chat,
            set_chat_agent,
            set_chat_options,
            rename_chat,
            rename_workspace,
            save_attachment,
            list_chat_files,
            answer_question,
            set_chat_plan,
            search_chats,
            restore_workspace,
            set_setup_script,
            set_settings,
            open_workspace,
            commit_workspace,
            push_workspace,
            discard_file,
            agent_defaults,
            mark_inbox_read,
            delete_inbox_item,
            start_review,
            refresh_inbox,
            open_url,
            refresh_pr,
            my_pull_requests,
            open_pr_workspace,
            set_auto_push,
            health,
            storage,
            pr_action,
            set_auto_pr,
            merge_group,
            warm_up_chat,
            fork_chat,
            create_group,
            rename_group,
            delete_group,
            set_group,
            archive_workspace,
            create_chat,
            get_transcript,
            send_message,
            interrupt,
            respond_permission,
            set_run_script,
            get_diff,
            list_files,
            read_file,
            write_file,
            term_open,
            term_write,
            term_resize,
            term_close,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|app, event| {
        // Leave nothing running behind: agents, dev servers in terminals.
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = app.try_state::<AppState>() {
                state.agents.stop_all_now();
                state.terminals.close_all();
            }
        }
    });
}
