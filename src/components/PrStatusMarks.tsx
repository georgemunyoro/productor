import type { PrStatus } from "../types";

/** What stands between a pull request and merging, as short chips. */
export function prChips(pr: PrStatus): { label: string; tone: string; title?: string }[] {
  if (pr.state === "MERGED") return [{ label: "Merged", tone: "accent" }];
  if (pr.state === "CLOSED") return [{ label: "Closed", tone: "muted" }];
  const chips: { label: string; tone: string; title?: string }[] = [];
  if (pr.draft) chips.push({ label: "Draft", tone: "muted" });
  if (pr.ci === "failing") {
    chips.push({ label: "CI failing", tone: "danger", title: pr.failingChecks.join(", ") || undefined });
  } else if (pr.ci === "pending") chips.push({ label: "CI running", tone: "waiting" });
  else if (pr.ci === "passing") chips.push({ label: "CI passing", tone: "running" });
  if (pr.review === "approved") chips.push({ label: "Approved", tone: "running" });
  else if (pr.review === "changes_requested") chips.push({ label: "Changes requested", tone: "danger" });
  else if (pr.review === "review_required") chips.push({ label: "Needs review", tone: "muted" });
  const threads = pr.unresolvedThreads.length;
  if (threads > 0) chips.push({ label: `${threads} unresolved`, tone: "waiting" });
  if (pr.mergeable === "conflicting") chips.push({ label: "Conflicts", tone: "danger" });
  return chips;
}

/** The one thing most worth knowing about a pull request, for tight spaces. */
function headline(pr: PrStatus): { glyph: string; tone: string; label: string } {
  if (pr.state === "MERGED") return { glyph: "✓", tone: "accent", label: "merged" };
  if (pr.state === "CLOSED") return { glyph: "×", tone: "muted", label: "closed" };
  if (pr.ci === "failing") return { glyph: "×", tone: "danger", label: "CI failing" };
  if (pr.mergeable === "conflicting") return { glyph: "!", tone: "danger", label: "merge conflicts" };
  if (pr.review === "changes_requested") return { glyph: "!", tone: "danger", label: "changes requested" };
  if (pr.unresolvedThreads.length > 0) {
    return { glyph: "!", tone: "waiting", label: `${pr.unresolvedThreads.length} unresolved comments` };
  }
  if (pr.ci === "pending") return { glyph: "…", tone: "waiting", label: "CI running" };
  if (pr.review === "approved") return { glyph: "✓", tone: "running", label: "approved, CI passing" };
  if (pr.ci === "passing") return { glyph: "✓", tone: "running", label: "CI passing" };
  return { glyph: "", tone: "muted", label: "open" };
}

/** Compact pull request indicator for a sidebar row: number plus one glyph. */
export function PrMark({ pr, hideNumber }: { pr: PrStatus; hideNumber?: boolean }) {
  const { glyph, tone, label } = headline(pr);
  // Where the number is already on show, only the state is worth adding.
  if (hideNumber && !glyph) return null;
  return (
    <span className={`pr-mark tone-${tone}`} title={`#${pr.number} ${pr.title}: ${label}`}>
      {!hideNumber && `#${pr.number}`}
      {glyph && <span aria-hidden>{hideNumber ? glyph : ` ${glyph}`}</span>}
      <span className="visually-hidden">, {label}</span>
    </span>
  );
}
