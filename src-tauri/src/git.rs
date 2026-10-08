use std::path::Path;
use tokio::process::Command;

/// Runs git and returns stdout exactly as written.
pub async fn git_raw(dir: &Path, args: &[&str], envs: &[(&str, &str)]) -> Result<String, String> {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .envs(envs.iter().copied())
        .output()
        .await
        .map_err(|e| format!("failed to run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

pub async fn git_env(dir: &Path, args: &[&str], envs: &[(&str, &str)]) -> Result<String, String> {
    git_raw(dir, args, envs).await.map(|out| out.trim().to_string())
}

pub async fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    git_env(dir, args, &[]).await
}

/// The ref new workspaces branch from: origin's default branch when there is
/// a remote, otherwise whatever is checked out.
pub async fn default_base(repo: &Path) -> Result<String, String> {
    if let Ok(head) = git(repo, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).await {
        return Ok(head);
    }
    for candidate in ["origin/main", "origin/master"] {
        if git(repo, &["rev-parse", "--verify", "--quiet", candidate]).await.is_ok() {
            return Ok(candidate.to_string());
        }
    }
    let current = git(repo, &["branch", "--show-current"]).await?;
    if current.is_empty() {
        git(repo, &["rev-parse", "HEAD"]).await
    } else {
        Ok(current)
    }
}

/// Writes the full working tree (tracked, modified and untracked files, but
/// not ignored ones) as a tree object, without touching HEAD, the index or
/// the working tree. Uses a throwaway copy of the index so an agent running
/// in the worktree is not disturbed.
pub async fn worktree_tree(worktree: &Path) -> Result<String, String> {
    let index = git(worktree, &["rev-parse", "--path-format=absolute", "--git-path", "index"]).await?;
    let tmp = std::env::temp_dir().join(format!("productor-index-{}", uuid::Uuid::new_v4()));
    if Path::new(&index).exists() {
        tokio::fs::copy(&index, &tmp).await.map_err(|e| e.to_string())?;
    }
    let tmp_str = tmp.to_string_lossy().to_string();
    let env = [("GIT_INDEX_FILE", tmp_str.as_str())];

    let result = async {
        git_env(worktree, &["add", "-A"], &env).await?;
        git_env(worktree, &["write-tree"], &env).await
    }
    .await;

    let _ = tokio::fs::remove_file(&tmp).await;
    result
}

/// Records the current working tree as a commit under `refname`.
pub async fn snapshot(worktree: &Path, refname: &str) -> Result<String, String> {
    let tree = worktree_tree(worktree).await?;
    let head = git(worktree, &["rev-parse", "HEAD"]).await?;
    let sha = git(
        worktree,
        &[
            "-c", "user.name=Productor",
            "-c", "user.email=productor@localhost",
            "commit-tree", &tree, "-p", &head, "-m", "productor snapshot",
        ],
    )
    .await?;
    git(worktree, &["update-ref", refname, &sha]).await?;
    Ok(sha)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn snapshot_captures_untracked_files_without_touching_the_index() {
        let dir = std::env::temp_dir().join(format!("productor-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]).await.unwrap();
        std::fs::write(dir.join("tracked.txt"), "one").unwrap();
        git(&dir, &["add", "."]).await.unwrap();
        git(&dir, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]).await.unwrap();

        std::fs::write(dir.join("tracked.txt"), "two").unwrap();
        std::fs::write(dir.join("new.txt"), "new").unwrap();
        let status_before = git(&dir, &["status", "--porcelain"]).await.unwrap();

        let sha = snapshot(&dir, "refs/productor/snapshots/test/1").await.unwrap();

        assert_eq!(git(&dir, &["show", &format!("{sha}:tracked.txt")]).await.unwrap(), "two");
        assert_eq!(git(&dir, &["show", &format!("{sha}:new.txt")]).await.unwrap(), "new");
        assert_eq!(git(&dir, &["rev-parse", "refs/productor/snapshots/test/1"]).await.unwrap(), sha);
        assert_eq!(git(&dir, &["status", "--porcelain"]).await.unwrap(), status_before);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
