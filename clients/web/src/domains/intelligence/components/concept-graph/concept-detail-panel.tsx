import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect } from "react";

import { FileMarkdown } from "@/components/file-markdown";
import { memoryGraphNodeOptions } from "@/domains/intelligence/memory-graph/get-memory-graph-node";
import { Button } from "@vellumai/design-library";

export interface ConceptDetailNode {
  id: string;
  label: string;
  updatedAtMs?: number;
}

interface ConceptDetailPanelProps {
  assistantId: string;
  node: ConceptDetailNode;
  onClose: () => void;
}

function formatUpdated(ms: number | undefined): string | null {
  if (!ms) return null;
  return new Date(ms).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * Slide-over drawer that renders a concept's own page (its markdown) when a
 * node is opened from the graph. The brain keeps rotating behind the translucent
 * backdrop; click the backdrop, the close button, or Escape to return.
 */
export function ConceptDetailPanel({
  assistantId,
  node,
  onClose,
}: ConceptDetailPanelProps) {
  const query = useQuery(memoryGraphNodeOptions(assistantId, node.id));
  const detail = query.data;
  const updated = formatUpdated(node.updatedAtMs);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
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
      <div
        className="absolute inset-0"
        style={{ backgroundColor: "color-mix(in srgb, var(--surface-base) 55%, transparent)" }}
        onClick={onClose}
      />
      <aside
        className="relative flex h-full min-h-0 w-full max-w-md flex-col overflow-hidden"
        style={{
          backgroundColor: "var(--surface-lift)",
          borderLeft: "1px solid var(--border-base)",
        }}
      >
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
            <FileMarkdown content={detail.content} />
          ) : (
            <p className="text-body-medium-lighter" style={{ color: "var(--content-tertiary)" }}>
              This concept doesn't have written content yet — it exists as a link
              in the graph, but its page is empty.
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}
