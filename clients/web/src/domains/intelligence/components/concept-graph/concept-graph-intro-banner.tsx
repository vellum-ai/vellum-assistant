import { Sparkles, X } from "lucide-react";

import { Button } from "@vellumai/design-library";

interface ConceptGraphIntroBannerProps {
  onDismiss: () => void;
}

/**
 * First-run explainer overlaid on the memory graph: says what the graph is and
 * that it keeps growing. Dismissible; dismissal is persisted per-assistant by
 * the caller so it never returns once closed. Rendered over both the empty
 * "no concepts yet" state (where it matters most) and a populated graph.
 *
 * Tagged `data-graph-control` so a pointer-down on the card doesn't start a
 * drag-orbit on the canvas behind it.
 */
export function ConceptGraphIntroBanner({
  onDismiss,
}: ConceptGraphIntroBannerProps) {
  return (
    <div
      data-graph-control
      className="pointer-events-auto absolute left-1/2 top-4 z-10 flex w-[min(30rem,calc(100%-6rem))] -translate-x-1/2 items-start gap-3 rounded-xl px-4 py-3"
      style={{
        backgroundColor: "var(--surface-lift)",
        border: "1px solid var(--border-base)",
        boxShadow:
          "0 8px 24px color-mix(in srgb, var(--content-default) 12%, transparent)",
      }}
    >
      <span
        className="mt-0.5 shrink-0"
        style={{ color: "var(--primary-base)" }}
        aria-hidden
      >
        <Sparkles size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <p
          className="text-body-medium-emphasised"
          style={{ color: "var(--content-default)" }}
        >
          This is your assistant's mind
        </p>
        <p
          className="mt-0.5 text-body-small-default"
          style={{ color: "var(--content-tertiary)" }}
        >
          Every idea it learns — and the links it draws between them — shows up
          here. The map grows and rearranges itself as you talk, so the more you
          share, the richer it gets.
        </p>
      </div>
      <Button
        variant="ghost"
        iconOnly={<X aria-hidden />}
        onClick={onDismiss}
        aria-label="Dismiss"
        tintColor="var(--content-tertiary)"
      />
    </div>
  );
}
