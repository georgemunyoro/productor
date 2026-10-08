import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { confirm } from "@tauri-apps/plugin-dialog";
import CodeMirror, { keymap, type Extension } from "@uiw/react-codemirror";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useStore, workspaceStatus } from "../store";
import type { Workspace } from "../types";
import { useUi } from "../ui";

interface TreeNode {
  name: string;
  path: string;
  children?: TreeNode[];
}

function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", children: [] };
  const dirs = new Map<string, TreeNode>([["", root]]);
  for (const path of paths) {
    const parts = path.split("/");
    let parent = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const dirPath = parts.slice(0, i + 1).join("/");
      let dir = dirs.get(dirPath);
      if (!dir) {
        dir = { name: parts[i], path: dirPath, children: [] };
        dirs.set(dirPath, dir);
        parent.children!.push(dir);
      }
      parent = dir;
    }
    parent.children!.push({ name: parts[parts.length - 1], path });
  }
  const sort = (node: TreeNode) => {
    node.children?.sort(
      (a, b) => Number(!a.children) - Number(!b.children) || a.name.localeCompare(b.name),
    );
    node.children?.forEach(sort);
  };
  sort(root);
  return root.children!;
}

function usePrefersDark() {
  const query = useMemo(() => window.matchMedia("(prefers-color-scheme: dark)"), []);
  const [dark, setDark] = useState(query.matches);
  useEffect(() => {
    const update = () => setDark(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [query]);
  return dark;
}

interface OpenFile {
  path: string;
  /** Contents on disk when last read or saved. */
  saved: string;
  content: string;
}

export function FilesPanel({ workspace }: { workspace: Workspace }) {
  const [paths, setPaths] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [file, setFile] = useState<OpenFile | null>(null);
  const [language, setLanguage] = useState<Extension | null>(null);
  const status = useStore((s) => workspaceStatus(workspace.id, s.chats, s.statuses));
  const reportError = useStore((s) => s.reportError);
  const systemDark = usePrefersDark();
  // The theme chosen in Settings wins over the system's.
  const theme = useUi((s) => s.theme);
  const dark = theme === "dark" || (theme === "system" && systemDark);

  const fileRef = useRef(file);
  fileRef.current = file;
  const dirty = file !== null && file.content !== file.saved;

  const refresh = useCallback(async () => {
    try {
      setPaths(await api.listFiles(workspace.id));
      // Pick up the agent's edits to the open file, unless that would
      // discard edits of the user's own.
      const current = fileRef.current;
      if (current && current.content === current.saved) {
        const fresh = await api.readFile(workspace.id, current.path).catch(() => null);
        if (fresh !== null && fileRef.current?.path === current.path) {
          setFile((f) => (f && f.content === f.saved ? { ...f, saved: fresh, content: fresh } : f));
        }
      }
    } catch (e) {
      reportError(e);
    }
  }, [workspace.id, reportError]);

  useEffect(() => {
    void refresh();
  }, [refresh, status]);

  const openFile = async (path: string) => {
    if (path === file?.path) return;
    if (dirty) {
      const discard = await confirm(`Discard unsaved changes to ${file!.path}?`, {
        title: "Unsaved changes",
        kind: "warning",
        okLabel: "Discard",
      });
      if (!discard) return;
    }
    try {
      const content = await api.readFile(workspace.id, path);
      setLanguage(null);
      setFile({ path, saved: content, content });
      const description = LanguageDescription.matchFilename(languages, path);
      if (description) {
        const support = await description.load();
        if (fileRef.current?.path === path) setLanguage(support);
      }
    } catch (e) {
      reportError(e);
    }
  };

  const save = useCallback(async () => {
    const current = fileRef.current;
    if (!current || current.content === current.saved) return;
    try {
      await api.writeFile(workspace.id, current.path, current.content);
      setFile((f) => (f && f.path === current.path ? { ...f, saved: current.content } : f));
    } catch (e) {
      reportError(e);
    }
  }, [workspace.id, reportError]);

  const extensions = useMemo(() => {
    const saveKey = keymap.of([
      {
        key: "Mod-s",
        run: () => {
          void save();
          return true;
        },
      },
    ]);
    return language ? [saveKey, language] : [saveKey];
  }, [language, save]);

  const tree = useMemo(() => buildTree(paths), [paths]);
  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return null;
    return paths.filter((p) => p.toLowerCase().includes(needle)).slice(0, 200);
  }, [paths, filter]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const renderNodes = (nodes: TreeNode[], depth: number): React.ReactNode =>
    nodes.map((node) =>
      node.children ? (
        <div key={node.path}>
          <button
            className="tree-row"
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => toggle(node.path)}
            aria-expanded={expanded.has(node.path)}
          >
            <span className="chevron" aria-hidden />
            {node.name}
          </button>
          {expanded.has(node.path) && renderNodes(node.children, depth + 1)}
        </div>
      ) : (
        <button
          key={node.path}
          className={"tree-row file" + (node.path === file?.path ? " selected" : "")}
          style={{ paddingLeft: 22 + depth * 12 }}
          onClick={() => openFile(node.path)}
        >
          {node.name}
        </button>
      ),
    );

  return (
    <div className="panel-body files">
      <div className="tree">
        <input
          className="tree-filter"
          value={filter}
          placeholder="Filter files…"
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="tree-scroll">
          {matches
            ? matches.map((path) => (
                <button
                  key={path}
                  className={"tree-row file flat" + (path === file?.path ? " selected" : "")}
                  title={path}
                  onClick={() => openFile(path)}
                >
                  {path}
                </button>
              ))
            : renderNodes(tree, 0)}
          {matches?.length === 0 && <p className="panel-empty">No matching files</p>}
        </div>
      </div>
      <div className="editor">
        {file ? (
          <>
            <div className="panel-toolbar">
              <span className="panel-summary editor-path" title={file.path}>
                {file.path}
                {dirty && <span className="dirty"> ●</span>}
              </span>
              <button className="button small" disabled={!dirty} onClick={save}>
                Save
              </button>
            </div>
            <CodeMirror
              key={file.path}
              className="editor-cm"
              value={file.content}
              height="100%"
              theme={dark ? oneDark : "light"}
              extensions={extensions}
              onChange={(content) => setFile((f) => (f ? { ...f, content } : f))}
            />
          </>
        ) : (
          <p className="panel-empty">Select a file to view or edit it.</p>
        )}
      </div>
    </div>
  );
}
