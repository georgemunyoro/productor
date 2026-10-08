use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub id: String,
    pub name: String,
    pub path: String,
    /// Command the terminal panel's Run button starts, e.g. a dev server.
    #[serde(default)]
    pub run_script: Option<String>,
    /// Command run in each new workspace's worktree, e.g. to install
    /// dependencies and copy untracked configuration.
    #[serde(default)]
    pub setup_script: Option<String>,
}

/// A pull request something is about without being its author's own work
/// on it: the one a review chat, or the workspace it was promoted into, is
/// reviewing.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LinkedPr {
    /// `owner/name`.
    pub repo: String,
    pub number: i64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub repo_id: String,
    pub name: String,
    pub branch: String,
    pub path: String,
    pub created_at: u64,
    #[serde(default)]
    pub archived: bool,
    /// Commit the workspace was created from.
    #[serde(default)]
    pub base_sha: Option<String>,
    #[serde(default)]
    pub group_id: Option<String>,
    /// The agent looks after this workspace's pull request without being
    /// asked: it starts on failing CI and on new review comments.
    #[serde(default)]
    pub auto_pr: bool,
    /// The commit whose CI failure the agent was last asked to fix.
    #[serde(default)]
    pub ci_fix_sha: Option<String>,
    /// CI fixes started unprompted since CI last passed.
    #[serde(default)]
    pub ci_fix_attempts: u32,
    /// Review threads the agent has already been asked to address.
    #[serde(default)]
    pub handled_threads: Vec<String>,
    /// Pushes to the workspace's own branch go ahead without asking.
    #[serde(default)]
    pub auto_push: bool,
    /// The commit whose merge conflicts the agent was last asked to resolve.
    #[serde(default)]
    pub conflict_sha: Option<String>,
    /// Set when the workspace exists to review someone's pull request. Its
    /// pull request status then follows that one, not its own branch.
    #[serde(default)]
    pub linked_pr: Option<LinkedPr>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
}

/// Where a forked chat's conversation comes from, until its agent first
/// starts and gets a session of its own.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ForkSource {
    pub session_id: String,
    /// The last assistant message to keep.
    pub at_uuid: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
    pub id: String,
    /// Which coding agent runs this chat: "claude" or "codex".
    #[serde(default = "default_agent")]
    pub agent: String,
    /// The workspace this chat works in. `None` for a quick chat.
    pub workspace_id: Option<String>,
    /// Set for quick chats, which belong to a repository rather than a workspace.
    #[serde(default)]
    pub repo_id: Option<String>,
    /// Directory a quick chat reads from.
    #[serde(default)]
    pub cwd: Option<String>,
    pub title: Option<String>,
    /// The agent's own session or thread id, set once it has started.
    pub session_id: Option<String>,
    pub created_at: u64,
    /// Number of completed turns; also the index of the next snapshot.
    #[serde(default)]
    pub turns: u32,
    /// Context to prepend to the next user message, e.g. after the chat moves
    /// to a different directory.
    #[serde(default)]
    pub pending_note: Option<String>,
    #[serde(default)]
    pub fork: Option<ForkSource>,
    /// Only meaningful for quick chats; a workspace's chats follow its group.
    #[serde(default)]
    pub group_id: Option<String>,
    /// The model to run, as the agent's CLI names it. `None` leaves the
    /// choice to the agent's own configuration.
    #[serde(default)]
    pub model: Option<String>,
    /// Whether to ask for the agent's fast mode. `None` leaves it to the
    /// agent's own configuration.
    #[serde(default)]
    pub fast: Option<bool>,
    /// The agent plans and waits for approval before changing anything.
    #[serde(default)]
    pub plan: bool,
    /// The pull request this chat is reviewing, if it is a review.
    #[serde(default)]
    pub linked_pr: Option<LinkedPr>,
    /// Set on a chat started from an inbox item. Such chats are reached
    /// through the inbox rather than listed in the sidebar.
    #[serde(default)]
    pub inbox_id: Option<String>,
}

fn default_agent() -> String {
    "claude".into()
}

impl Chat {
    pub fn new(workspace_id: Option<String>, repo_id: Option<String>, cwd: Option<String>) -> Self {
        Chat {
            id: uuid::Uuid::new_v4().to_string(),
            agent: default_agent(),
            workspace_id,
            repo_id,
            cwd,
            title: None,
            session_id: None,
            created_at: crate::now_ms(),
            turns: 0,
            pending_note: None,
            fork: None,
            group_id: None,
            plan: false,
            linked_pr: None,
            inbox_id: None,
            model: None,
            fast: None,
        }
    }
}

/// Something on GitHub that wants the user's attention. For now that is
/// always a pull request waiting on their review.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct InboxItem {
    pub id: String,
    /// "review_request".
    pub kind: String,
    /// Identifies the request, e.g. "rr:owner/name#12".
    pub key: String,
    /// `owner/name`, lowercased.
    pub repo: String,
    pub number: i64,
    pub title: String,
    pub author: String,
    pub url: String,
    /// The agent's review, once one has been started.
    pub chat_id: Option<String>,
    /// new, running, needs_approval, done or failed.
    pub status: String,
    /// The agent's findings, once it has finished.
    pub summary: String,
    pub created_at: u64,
    /// When the pull request last changed on GitHub, as GitHub reports it.
    pub updated_at: String,
    pub read: bool,
    /// The review was asked of the user by name, rather than of a team they
    /// belong to.
    pub direct: bool,
    /// The user removed it from the inbox. It is remembered, hidden, for as
    /// long as the request stands, so the next check does not bring it back.
    pub dismissed: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Let Claude Code bill an `ANTHROPIC_API_KEY` from the environment
    /// instead of the subscription login.
    pub use_api_key: bool,
    /// Command that opens a folder in the user's editor.
    pub editor: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { use_api_key: false, editor: "code".into() }
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Data {
    #[serde(default)]
    pub repos: Vec<Repo>,
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
    #[serde(default)]
    pub chats: Vec<Chat>,
    #[serde(default)]
    pub groups: Vec<Group>,
    #[serde(default)]
    pub inbox: Vec<InboxItem>,
    /// Whether GitHub has been checked at least once. The first check fills
    /// the inbox quietly instead of notifying about everything at once.
    #[serde(default)]
    pub inbox_synced: bool,
    #[serde(default)]
    pub settings: Settings,
}

pub struct Store {
    dir: PathBuf,
    pub data: Data,
}

impl Store {
    pub fn load(dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(dir.join("chats"));
        let path = dir.join("state.json");
        let mut data: Data = match fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str(&text) {
                Ok(data) => data,
                Err(e) => {
                    // Starting empty would overwrite the unreadable file on the
                    // next save, so keep a copy of it first.
                    let backup = dir.join(format!("state.unreadable-{}.json", crate::now_ms()));
                    eprintln!("could not read {}: {e}; keeping it as {}", path.display(), backup.display());
                    let _ = fs::copy(&path, &backup);
                    Data::default()
                }
            },
            Err(_) => Data::default(),
        };
        // Drop inbox entries written by earlier versions with another shape.
        data.inbox.retain(|item| item.kind == "review_request");
        // Reviews started before pull requests were linked: recover the link
        // from the inbox item, and pass it on to a workspace the review was
        // promoted into.
        for chat in data.chats.iter_mut().filter(|c| c.linked_pr.is_none()) {
            let item = chat.inbox_id.as_ref().and_then(|id| data.inbox.iter().find(|i| &i.id == id));
            if let Some(item) = item {
                chat.linked_pr = Some(LinkedPr { repo: item.repo.clone(), number: item.number });
            }
        }
        for workspace in data.workspaces.iter_mut().filter(|w| w.linked_pr.is_none()) {
            workspace.linked_pr = data
                .chats
                .iter()
                .find(|c| c.workspace_id.as_deref() == Some(&workspace.id) && c.linked_pr.is_some())
                .and_then(|c| c.linked_pr.clone());
        }
        Store { dir, data }
    }

    pub fn save(&self) -> Result<(), String> {
        let tmp = self.dir.join("state.json.tmp");
        let json = serde_json::to_string_pretty(&self.data).map_err(|e| e.to_string())?;
        fs::write(&tmp, json).map_err(|e| e.to_string())?;
        fs::rename(&tmp, self.dir.join("state.json")).map_err(|e| e.to_string())
    }

    fn chat_log(&self, chat_id: &str) -> PathBuf {
        self.dir.join("chats").join(format!("{chat_id}.jsonl"))
    }

    pub fn append_event(&self, chat_id: &str, event: &Value) {
        if let Ok(mut f) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.chat_log(chat_id))
        {
            let _ = writeln!(f, "{event}");
        }
    }

    /// Where files attached to messages are kept.
    pub fn attachments_dir(&self) -> PathBuf {
        self.dir.join("attachments")
    }

    /// Marks turns that were under way when the app last stopped. Called at
    /// startup, when no agent is running, so a message with no result after
    /// it can only have been cut off.
    pub fn mark_interrupted(&self) {
        for chat in &self.data.chats {
            let events = self.read_events(&chat.id);
            let last = |kinds: &[&str]| events.iter().rposition(|e| kinds.contains(&e["type"].as_str().unwrap_or("")));
            let asked = last(&["productor_user"]);
            let settled = last(&["result", "productor_interrupted"]);
            if asked.is_some() && asked > settled {
                self.append_event(&chat.id, &serde_json::json!({ "type": "productor_interrupted", "ts": crate::now_ms() }));
            }
        }
    }

    pub fn delete_events(&self, chat_id: &str) {
        let _ = fs::remove_file(self.chat_log(chat_id));
    }

    pub fn read_events(&self, chat_id: &str) -> Vec<Value> {
        fs::read_to_string(self.chat_log(chat_id))
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }

    pub fn chat(&self, id: &str) -> Option<&Chat> {
        self.data.chats.iter().find(|c| c.id == id)
    }

    pub fn chat_mut(&mut self, id: &str) -> Option<&mut Chat> {
        self.data.chats.iter_mut().find(|c| c.id == id)
    }

    pub fn workspace(&self, id: &str) -> Option<&Workspace> {
        self.data.workspaces.iter().find(|w| w.id == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_reviews_saved_before_pull_requests_were_linked() {
        let dir = std::env::temp_dir().join(format!("productor-store-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let state = serde_json::json!({
            "inbox": [{ "id": "i1", "kind": "review_request", "key": "rr:o/r#7", "repo": "o/r", "number": 7, "status": "done", "chatId": "promoted" },
                      { "id": "i2", "kind": "review_request", "key": "rr:o/r#8", "repo": "o/r", "number": 8, "status": "done", "chatId": "readonly" }],
            "workspaces": [{ "id": "w1", "repoId": "r", "name": "Review #7", "branch": "g/x", "path": "/tmp/x", "createdAt": 0 },
                           { "id": "w2", "repoId": "r", "name": "ordinary", "branch": "g/y", "path": "/tmp/y", "createdAt": 0 }],
            "chats": [{ "id": "promoted", "workspaceId": "w1", "inboxId": "i1", "title": "t", "sessionId": null, "createdAt": 0 },
                      { "id": "readonly", "workspaceId": null, "inboxId": "i2", "title": "t", "sessionId": null, "createdAt": 0 },
                      { "id": "plain", "workspaceId": "w2", "title": "t", "sessionId": null, "createdAt": 0 }],
        });
        fs::write(dir.join("state.json"), state.to_string()).unwrap();

        let store = Store::load(dir.clone());
        let pr = |number| Some(LinkedPr { repo: "o/r".into(), number });
        assert_eq!(store.chat("promoted").unwrap().linked_pr, pr(7));
        assert_eq!(store.chat("readonly").unwrap().linked_pr, pr(8));
        assert_eq!(store.chat("plain").unwrap().linked_pr, None);
        assert_eq!(store.workspace("w1").unwrap().linked_pr, pr(7), "a promoted review's workspace follows the same pull request");
        assert_eq!(store.workspace("w2").unwrap().linked_pr, None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn marks_only_turns_that_never_finished() {
        let dir = std::env::temp_dir().join(format!("productor-store-{}", uuid::Uuid::new_v4()));
        let mut store = Store::load(dir.clone());
        for id in ["done", "cut"] {
            let mut chat = Chat::new(None, None, None);
            chat.id = id.into();
            store.data.chats.push(chat);
        }
        let event = |kind: &str| serde_json::json!({ "type": kind });
        for kind in ["productor_user", "assistant", "result"] {
            store.append_event("done", &event(kind));
        }
        for kind in ["productor_user", "assistant", "result", "productor_user", "assistant"] {
            store.append_event("cut", &event(kind));
        }
        store.mark_interrupted();
        store.mark_interrupted();
        let kinds = |id: &str| store.read_events(id).iter().map(|e| e["type"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(kinds("done").last().unwrap(), "result");
        assert_eq!(kinds("cut").iter().filter(|k| *k == "productor_interrupted").count(), 1, "marked once, not on every start");
        assert_eq!(kinds("cut").last().unwrap(), "productor_interrupted");
        fs::remove_dir_all(&dir).unwrap();
    }
}
