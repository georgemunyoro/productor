import type { CSSProperties } from "react";

/**
 * Colour tags from the design system. Every repository and group carries
 * one, and nothing else uses them. The tag is derived from the id, so it is
 * stable without having to be stored or chosen.
 */
const TAGS = ["grape", "coral", "sun", "leaf", "sky"] as const;

export type Tag = (typeof TAGS)[number];

export function tagFor(id: string): Tag {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return TAGS[hash % TAGS.length];
}

/** Sets the tag in effect for an element and everything inside it. */
export function tagStyle(id: string | undefined): CSSProperties | undefined {
  if (!id) return undefined;
  const tag = tagFor(id);
  return {
    "--tag": `var(--tag-${tag})`,
    // Yellow is too light to carry white text on a solid fill.
    "--tag-ink": tag === "sun" ? "#1f1a17" : "#fff",
  } as CSSProperties;
}
