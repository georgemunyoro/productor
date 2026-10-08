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
        }
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
}

pub struct Store {
    dir: PathBuf,
    pub data: Data,
}

impl Store {
    pub fn load(dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(dir.join("chats"));
        let data = fs::read_to_string(dir.join("state.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
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
