import { useQuery } from "@tanstack/react-query";
import { MessageCircle, Sparkles, X } from "lucide-react";
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
  /**
   * Opens a fresh chat seeded with a message about this concept. When absent,
   * the chat-from-node actions are hidden (read-only drawer). Provided from the
   * identity page, which navigates to a draft conversation and auto-sends.
   */
  onOpenThread?: (message: string) => void;
}

function formatUpdated(ms: number | undefined): string | null {
  if (!ms) {return null;}
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
  onOpenThread,
}: ConceptDetailPanelProps) {
  const query = useQuery(memoryGraphNodeOptions(assistantId, node.id));
  const detail = query.data;
  const updated = formatUpdated(node.updatedAtMs);
  const title = detail?.title ?? node.label;

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
