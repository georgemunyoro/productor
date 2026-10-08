export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: "added" | "deleted" | "modified" | "renamed";
  binary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

/** Git quotes paths containing unusual characters; undo the common escapes. */
function unquote(path: string): string {
  if (!path.startsWith('"')) return path;
  return path.slice(1, -1).replace(/\\(["\\tn])/g, (_, c) => (c === "t" ? "\t" : c === "n" ? "\n" : c));
}

function stripPrefix(path: string): string | undefined {
  const clean = unquote(path.replace(/\t.*$/, ""));
  if (clean === "/dev/null") return undefined;
  return clean.replace(/^[ab]\//, "");
}

/** Parses the output of `git diff` into files, hunks and numbered lines. */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldNo = 0;
  let newNo = 0;

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git (?:"?a\/.*"?) "?b\/(.*?)"?$/.exec(line);
      file = {
        path: match ? match[1] : line.slice(11),
        status: "modified",
        binary: false,
        hunks: [],
        additions: 0,
        deletions: 0,
      };
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (!file) continue;

    if (!hunk) {
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("rename from ")) {
        file.status = "renamed";
        file.oldPath = unquote(line.slice(12));
      } else if (line.startsWith("rename to ")) file.path = unquote(line.slice(10));
      else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch"))
        file.binary = true;
      else if (line.startsWith("--- ")) {
        const path = stripPrefix(line.slice(4));
        if (path && file.status !== "renamed") file.oldPath = path;
      } else if (line.startsWith("+++ ")) {
        const path = stripPrefix(line.slice(4));
        if (path) file.path = path;
        else if (file.oldPath) file.path = file.oldPath;
      }
    }

    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: line.slice(1), newNo: newNo++ });
      file.additions++;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ });
      file.deletions++;
    } else if (line.startsWith(" ")) {
      hunk.lines.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  for (const f of files) if (f.status !== "renamed" && f.oldPath === f.path) delete f.oldPath;
  return files;
}
