import hljs from "highlight.js/lib/common";

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The highlight.js language for a file, from its extension, if it knows one. */
export function languageFor(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  return hljs.getLanguage(extension) ? extension : undefined;
}

/**
 * One line of code as highlighted HTML. Lines are highlighted on their own,
 * so a construct spanning several lines (a block comment, say) may be
 * coloured as code; a diff only ever has fragments to work with.
 */
export function highlightLine(text: string, language: string | undefined): string {
  if (!language || text.length > 2000) return escape(text);
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return escape(text);
  }
}
