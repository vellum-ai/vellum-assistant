import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  MessageCircle,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";

import { FileMarkdown } from "@/components/file-markdown";
import { memoryGraphNodeOptions } from "@/domains/intelligence/memory-graph/get-memory-graph-node";
import { Button } from "@vellumai/design-library";

import { EDGE_LEARNED_COLOR } from "./constants";

export interface ConceptDetailNode {
  id: string;
  label: string;
  updatedAtMs?: number;
}

interface ConceptDetailPanelProps {
  assistantId: string;
  node: ConceptDetailNode;
  /**
   * The navigable trail of opened concepts (root → current). Rendered as a
   * clickable breadcrumb header so deeper travels can be rewound in place.
   */
  trail: ConceptDetailNode[];
  /**
   * Direct neighbors of the open concept for the flat WIRED-TO list. `kind`
   * (link vs learned) tags each row without grouping them.
   */
  neighbors: { id: string; label: string; kind?: string }[];
  /** Travel to a neighbor: pushes the trail and re-centers, panel stays open. */
  onTravel: (node: ConceptDetailNode) => void;
  /** Jump to a breadcrumb: truncates the trail to `index` and re-centers. */
  onCrumb: (index: number) => void;
  onClose: () => void;
  /**
   * Opens a fresh chat seeded with a message about this concept. When absent,
   * the chat-from-node actions are hidden (read-only drawer). Provided from the
   * identity page, which navigates to a draft conversation and auto-sends.
   */
  onOpenThread?: (message: string) => void;
}

type Crumb = { node: ConceptDetailNode; index: number };

// Collapse a deep trail to first + last few so the breadcrumb never overflows:
// A › … › X › Y › Z. The "ellipsis" marker is inert; every rendered crumb keeps
// its original trail index so clicking one truncates to exactly that node.
function buildCrumbs(trail: ConceptDetailNode[]): (Crumb | "ellipsis")[] {
  const TAIL = 3;
  if (trail.length <= TAIL + 1) {
    return trail.map((node, index) => ({ node, index }));
  }
  const tail: Crumb[] = trail
    .slice(-TAIL)
    .map((node, i) => ({ node, index: trail.length - TAIL + i }));
  return [{ node: trail[0], index: 0 }, "ellipsis", ...tail];
}

function formatUpdated(ms: number | undefined): string | null {
  if (!ms) {return null;}
  return new Date(ms).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// Only preview once a note runs past roughly a screenful. Character count is a
// cheap proxy for rendered height that avoids measuring the markdown; below
// this the note renders whole with no toggle.
const LONG_NOTE_THRESHOLD = 600;

/**
 * Slice a long note down to a preview of at most ~`LONG_NOTE_THRESHOLD` chars.
 * Prefer cutting at the last newline before the threshold so we don't slice
 * through mid-markdown syntax (a link, a heading, a list marker); fall back to
 * a hard character slice when there's no usable newline. Only honor a newline
 * that keeps a substantial preview, so a stray early line break doesn't
 * collapse it to almost nothing.
 */
function buildNotePreview(content: string): string {
  const hardSlice = content.slice(0, LONG_NOTE_THRESHOLD);
  const lastNewline = hardSlice.lastIndexOf("\n");
  if (lastNewline > LONG_NOTE_THRESHOLD / 2) {
    return content.slice(0, lastNewline);
  }
  return hardSlice;
}

/**
 * The concept's own markdown body. Long notes render a sliced preview with a
 * "Read full note" / "Show less" toggle; short notes render whole with no
 * toggle. Because only the currently-shown content is in the DOM (a real
 * content slice rather than a clipped-and-hidden full body), everything visible
 * is in the a11y tree and nothing off-screen is focusable — the preview reads
 * the same for screen-reader and sighted users.
 */
function ConceptNote({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);

  if (content.length <= LONG_NOTE_THRESHOLD) {
    return <FileMarkdown content={content} />;
  }

  return (
    <>
      <FileMarkdown content={expanded ? content : buildNotePreview(content)} />
      <Button
        variant="ghost"
        size="compact"
        className="-ml-2 mt-1"
        onClick={() => setExpanded((prev) => !prev)}
        rightIcon={
          expanded ? (
            <ChevronUp size={16} aria-hidden />
          ) : (
            <ChevronDown size={16} aria-hidden />
          )
        }
      >
        {expanded ? "Show less" : "Read full note"}
      </Button>
    </>
  );
}

/**
 * Slide-over drawer that renders a concept's own page (its markdown) when a
 * node is opened from the graph. A clickable breadcrumb header rewinds the
 * travel trail, and a flat WIRED-TO list travels to a neighbor without closing
 * the drawer. The brain keeps rotating behind the light backdrop; click the
 * backdrop, the close button, or Escape to return.
 */
export function ConceptDetailPanel({
  assistantId,
  node,
  trail,
  neighbors,
  onTravel,
  onCrumb,
  onClose,
  onOpenThread,
}: ConceptDetailPanelProps) {
  const query = useQuery(memoryGraphNodeOptions(assistantId, node.id));
  const detail = query.data;
  const updated = formatUpdated(node.updatedAtMs);
  const title = detail?.title ?? node.label;
  const crumbs = buildCrumbs(trail);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {onClose();}
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      data-graph-panel
      className="absolute inset-0 z-20 flex justify-end"
      // Keep pointer interactions off the rotating canvas behind the panel.
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
    >
      {/* Light scrim — kept clickable (backdrop-to-close) but barely tinted so
          the ego-dimmed focused node + its labeled neighbors stay visible on the
          canvas beside the drawer instead of being blacked out. */}
      <div
        className="absolute inset-0"
        style={{ backgroundColor: "color-mix(in srgb, var(--surface-base) 16%, transparent)" }}
        onClick={onClose}
      />
      <aside
        className="relative flex h-full min-h-0 w-full max-w-md flex-col overflow-hidden"
        style={{
          backgroundColor: "var(--surface-lift)",
          borderLeft: "1px solid var(--border-base)",
        }}
      >
        {/* Breadcrumb header — only when the trail runs deeper than the current
            node (the single-crumb case just repeats the title below). Crumbs
            jump back + re-center via onCrumb; the ‹ back control mirrors it. */}
        {trail.length > 1 ? (
          <nav
            aria-label="Concept trail"
            className="flex shrink-0 items-center gap-1 overflow-hidden border-b px-5 py-2 text-body-small-default"
            style={{ borderColor: "var(--border-base)", color: "var(--content-tertiary)" }}
          >
            <button
              type="button"
              onClick={() => onCrumb(trail.length - 2)}
              aria-label="Back"
              className="-ml-1 mr-0.5 flex shrink-0 items-center rounded p-0.5 hover:bg-[color-mix(in_srgb,var(--content-tertiary)_14%,transparent)]"
              style={{ color: "var(--content-tertiary)" }}
            >
              <ChevronLeft size={16} aria-hidden />
            </button>
            {crumbs.map((crumb, i) => (
              // Key by trail position, not node id: travel is push-only, so the
              // same concept can sit at more than one depth (A › B › A).
              <span
                key={crumb === "ellipsis" ? "ellipsis" : crumb.index}
                className="flex min-w-0 items-center gap-1"
              >
                {i > 0 ? <span aria-hidden>›</span> : null}
                {crumb === "ellipsis" ? (
                  <span aria-hidden>…</span>
                ) : crumb.index === trail.length - 1 ? (
                  <span
                    aria-current="page"
                    className="max-w-[9rem] truncate"
                    style={{ color: "var(--content-default)" }}
                  >
                    {crumb.node.label}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onCrumb(crumb.index)}
                    className="max-w-[8rem] truncate rounded hover:underline"
                    style={{ color: "var(--content-tertiary)" }}
                  >
                    {crumb.node.label}
                  </button>
                )}
              </span>
            ))}
          </nav>
        ) : null}

        <header
          className="flex shrink-0 items-start justify-between gap-3 border-b px-5 py-4"
          style={{ borderColor: "var(--border-base)" }}
        >
          <div className="min-w-0">
            <h2
              className="truncate text-title-small"
              style={{ color: "var(--content-default)" }}
              title={detail?.title ?? node.label}
            >
              {detail?.title ?? node.label}
            </h2>
            {updated ? (
              <p
                className="mt-0.5 text-body-small-default"
                style={{ color: "var(--content-tertiary)" }}
              >
                Updated {updated}
              </p>
            ) : null}
          </div>
          <Button
            variant="ghost"
            iconOnly={<X aria-hidden />}
            onClick={onClose}
            aria-label="Close"
            tintColor="var(--content-tertiary)"
          />
        </header>

        <div
          className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
          style={{ touchAction: "pan-y" }}
        >
          {query.isLoading ? (
            <div className="flex justify-center py-8">
              <div
                className="h-5 w-5 animate-spin rounded-full border-2"
                style={{
                  borderColor: "var(--border-base)",
                  borderTopColor: "var(--content-tertiary)",
                }}
              />
            </div>
          ) : query.isError ? (
            <p className="text-body-medium-lighter" style={{ color: "var(--content-tertiary)" }}>
              Couldn't load this concept. Try again in a moment.
            </p>
          ) : detail?.found && detail.content?.trim() ? (
            // Keyed by node id so travelling to a new concept remounts the note
            // and starts it collapsed again.
            <ConceptNote key={node.id} content={detail.content} />
          ) : (
            <p className="text-body-medium-lighter" style={{ color: "var(--content-tertiary)" }}>
              This concept doesn't have written content yet — it exists as a link
              in the graph, but its page is empty.
            </p>
          )}

          {/* WIRED-TO — a flat neighbor list (no category grouping) with a
              connection count. Clicking a neighbor travels to it: pushes the
              trail and re-centers the canvas without closing the drawer. */}
          {neighbors.length > 0 ? (
            <section
              className="mt-6 border-t pt-4"
              style={{ borderColor: "var(--border-base)" }}
            >
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <h3
                  className="text-body-small-default uppercase tracking-wide"
                  style={{ color: "var(--content-tertiary)" }}
                >
                  Wired to
                </h3>
                <span
                  className="text-body-small-default tabular-nums"
                  style={{ color: "var(--content-tertiary)" }}
                >
                  {neighbors.length} connection{neighbors.length === 1 ? "" : "s"}
                </span>
              </div>
              <ul className="flex list-none flex-col gap-0.5">
                {neighbors.map((neighbor) => (
                  <li key={neighbor.id}>
                    <button
                      type="button"
                      onClick={() =>
                        onTravel({ id: neighbor.id, label: neighbor.label })
                      }
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-body-medium-default hover:bg-[color-mix(in_srgb,var(--content-tertiary)_12%,transparent)]"
                      style={{ color: "var(--content-default)" }}
                    >
                      <span
                        aria-hidden
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{
                          backgroundColor:
                            neighbor.kind === "learned"
                              ? EDGE_LEARNED_COLOR
                              : "var(--content-tertiary)",
                        }}
                      />
                      <span className="truncate">{neighbor.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        {onOpenThread ? (
          <footer
            className="flex shrink-0 gap-2 border-t px-5 py-3"
            style={{ borderColor: "var(--border-base)" }}
          >
            <Button
              variant="outlined"
              size="regular"
              className="flex-1"
              leftIcon={<MessageCircle size={16} aria-hidden />}
              onClick={() =>
                onOpenThread(
                  `Tell me what you remember about "${title}" and how it connects to the rest of what you know.`,
                )
              }
            >
              Ask about this
            </Button>
            <Button
              variant="primary"
              size="regular"
              className="flex-1"
              leftIcon={<Sparkles size={16} aria-hidden />}
              onClick={() =>
                onOpenThread(
                  `I want to refine what you remember about "${title}". Ask me what's off and we'll correct it together.`,
                )
              }
            >
              Refine
            </Button>
          </footer>
        ) : null}
      </aside>
    </div>
  );
}
