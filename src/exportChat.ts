import type { AgentEvent } from "./types";

/** A conversation as Markdown: what was said, without the tool calls. */
export function conversationMarkdown(title: string, events: AgentEvent[]): string {
  const parts: string[] = [`# ${title}`];
  for (const event of events) {
    if (event.type === "productor_user") {
      parts.push(`## You\n\n${event.text}`);
    } else if (event.type === "assistant" && !event.parent_tool_use_id) {
      const text = (event.message?.content ?? [])
        .filter((block: AgentEvent) => block.type === "text" && block.text.trim())
        .map((block: AgentEvent) => block.text)
        .join("\n\n");
      if (!text) continue;
      // Consecutive replies within a turn read as one answer.
      const last = parts[parts.length - 1];
      if (last.startsWith("## Agent")) parts[parts.length - 1] = `${last}\n\n${text}`;
      else parts.push(`## Agent\n\n${text}`);
    }
  }
  return parts.join("\n\n") + "\n";
}
