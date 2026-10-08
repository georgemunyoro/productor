//! File access for the editor panel, confined to a workspace's worktree.

use crate::git;
use std::path::{Component, Path, PathBuf};

const MAX_EDITABLE_BYTES: u64 = 2 * 1024 * 1024;

/// Tracked and untracked files, minus anything gitignored.
pub async fn list(root: &Path) -> Result<Vec<String>, String> {
    let out = git::git_raw(root, &["ls-files", "-z", "--cached", "--others", "--exclude-standard"], &[]).await?;
    let mut files: Vec<String> = out.split('\0').filter(|p| !p.is_empty()).map(String::from).collect();
    files.sort();
    files.dedup();
    Ok(files)
}

/// Resolves a worktree-relative path, refusing anything that would land
/// outside the worktree, whether through `..` or a symlinked directory.
fn resolve(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let rel = Path::new(relative);
    if relative.is_empty() || !rel.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(format!("invalid path: {relative}"));
    }
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let full = root.join(rel);
    let parent = full.parent().ok_or("invalid path")?;
    let parent = parent.canonicalize().map_err(|e| format!("{relative}: {e}"))?;
    if !parent.starts_with(&root) {
        return Err(format!("{relative} is outside the workspace"));
    }
    Ok(full)
}

pub async fn read(root: &Path, relative: &str) -> Result<String, String> {
    let path = resolve(root, relative)?;
    let meta = tokio::fs::metadata(&path).await.map_err(|e| format!("{relative}: {e}"))?;
    if meta.len() > MAX_EDITABLE_BYTES {
        return Err(format!("{relative} is too large to open here"));
    }
    let bytes = tokio::fs::read(&path).await.map_err(|e| format!("{relative}: {e}"))?;
    String::from_utf8(bytes).map_err(|_| format!("{relative} is not a text file"))
}

pub async fn write(root: &Path, relative: &str, content: &str) -> Result<(), String> {
    let path = resolve(root, relative)?;
    tokio::fs::write(&path, content).await.map_err(|e| format!("{relative}: {e}"))
}

pub async fn remove(root: &Path, relative: &str) -> Result<(), String> {
    let path = resolve(root, relative)?;
    tokio::fs::remove_file(&path).await.map_err(|e| format!("{relative}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_cannot_escape_the_workspace() {
        let root = std::env::temp_dir().join(format!("productor-files-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::os::unix::fs::symlink("/etc", root.join("link")).unwrap();

        assert!(resolve(&root, "src/new.txt").is_ok());
        assert!(resolve(&root, "../outside.txt").is_err());
        assert!(resolve(&root, "/etc/hosts").is_err());
        assert!(resolve(&root, "src/../../outside.txt").is_err());
        assert!(resolve(&root, "link/hosts").is_err());
        assert!(resolve(&root, "").is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
