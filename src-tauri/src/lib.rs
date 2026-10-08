mod agent;
mod codex;
mod files;
mod fork;
mod git;
mod store;
mod terminal;

use agent::Agents;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use store::{Chat, Group, Repo, Store, Workspace};
use tauri::{AppHandle, Manager, State};

pub struct AppState {
    pub store: Mutex<Store>,
    pub agents: Agents,
    pub terminals: terminal::Terminals,
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
        "statuses": state.agents.statuses(),
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
    let repo = Repo { id: new_id(), name, path: root, run_script: None };
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
async fn make_workspace(state: &AppState, repo_id: &str, from: Option<StartPoint>) -> Result<Workspace, String> {
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
        Some(from) => {
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
        None => {
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
    };
    let mut store = state.store.lock().unwrap();
    store.data.workspaces.push(workspace.clone());
    store.save()?;
    Ok(workspace)
}

/// Fetches and returns the ref or commit new work should start from.
async fn fresh_base(repo_path: &Path) -> Result<String, String> {
    let _ = git::git(repo_path, &["fetch", "--quiet", "origin"]).await;
    let mut base = git::default_base(repo_path).await?;
    // A bare clone has no remote-tracking branches, so a plain fetch leaves
    // its local branches stale. Fetch the default branch directly instead.
    if !base.starts_with("origin/")
        && is_bare(repo_path).await
        && git::git(repo_path, &["fetch", "--quiet", "origin", &base]).await.is_ok()
    {
        if let Ok(fetched) = git::git(repo_path, &["rev-parse", "FETCH_HEAD"]).await {
            base = fetched;
        }
    }
    Ok(base)
}

async fn is_bare(repo_path: &Path) -> bool {
    git::git(repo_path, &["rev-parse", "--is-bare-repository"]).await.as_deref() == Ok("true")
}

#[tauri::command]
async fn create_workspace(state: State<'_, AppState>, repo_id: String) -> Result<Value, String> {
    let workspace = make_workspace(&state, &repo_id, None).await?;
    let chat = Chat::new(Some(workspace.id.clone()), None, None);
    let mut store = state.store.lock().unwrap();
    store.data.chats.push(chat.clone());
    store.save()?;
    Ok(json!({ "workspace": workspace, "chat": chat }))
}

/// Opens a read-only chat against the repository's main checkout, with no
/// worktree to set up. A bare repository has no checkout, so its quick chats
/// share one detached worktree that is created on first use.
#[tauri::command]
async fn create_quick_chat(app: AppHandle, state: State<'_, AppState>, repo_id: String) -> Result<Chat, String> {
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
        // another quick chat is in the middle of reading it.
        let others_busy = {
            let store = state.store.lock().unwrap();
            store.data.chats.iter().any(|c| c.repo_id.as_deref() == Some(&repo_id) && agent::is_busy(&app, &c.id))
        };
        if !others_busy {
            tauri::async_runtime::spawn(async move {
                if let Ok(base) = fresh_base(&repo_path).await {
                    let _ = git::git(&checkout, &["checkout", "--quiet", "--detach", &base]).await;
                }
            });
        }
        checkout_str
    } else {
        repo.path.clone()
    };

    let chat = Chat::new(None, Some(repo_id), Some(cwd));
    {
        let mut store = state.store.lock().unwrap();
        store.data.chats.push(chat.clone());
        store.save()?;
    }
    Ok(chat)
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

    let workspace = make_workspace(&state, &repo_id, None).await?;
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
             you can now edit files and run commands in the new worktree.",
            workspace.path, workspace.branch
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

#[tauri::command]
fn delete_chat(state: State<AppState>, chat_id: String) -> Result<(), String> {
    state.agents.stop(&chat_id);
    let mut store = state.store.lock().unwrap();
    store.data.chats.retain(|c| c.id != chat_id);
    store.delete_events(&chat_id);
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
async fn send_message(app: AppHandle, chat_id: String, text: String) -> Result<(), String> {
    agent::send_message(&app, &chat_id, &text)
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
    Ok(json!({ "base": base, "diff": diff }))
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
    state.terminals.open(&app, &workspace_id, &cwd, cols, rows, command)
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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            app.manage(AppState {
                store: Mutex::new(Store::load(dir)),
                agents: Agents::default(),
                terminals: terminal::Terminals::default(),
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
