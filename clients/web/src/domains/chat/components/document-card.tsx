/**
 * The card that stands for a document in the transcript: a bordered row naming
 * the document, with an "opens it" affordance.
 *
 * A document reaches the transcript two ways: the daemon's inline
 * `document_preview` surface (`DocumentPreviewSurface`) and the
 * end-of-response affordance the transcript derives from a turn's document
 * tool calls (`DocumentReopenLink`). Both draw through this component so
 * the two cannot drift into looking like different kinds of thing.
 */

import { ArrowUpRight, FileText } from "lucide-react";
import type { KeyboardEvent } from "react";

export interface DocumentCardProps {
  /** Title to show for the document. */
  documentName: string;
  /** Optional MIME tag, shown as a chip beside the name. */
  mimeType?: string;
  /** Optional inline excerpt of the document's content. */
  content?: string;
  /** Opens the document. Omitted for a card that is not actionable. */
  onOpen?: () => void;
  /** Accessible name for the open gesture. */
  ariaLabel?: string;
  testId?: string;
}

export function DocumentCard({
  documentName,
  mimeType,
  content,
  onOpen,
  ariaLabel,
  testId,
}: DocumentCardProps) {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen?.();
    }
  };

  return (
    <div className="max-w-sm">
      <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-lift)] p-4">
        <div
          role={onOpen ? "button" : undefined}
          tabIndex={onOpen ? 0 : undefined}
          aria-label={onOpen ? ariaLabel : undefined}
          data-testid={testId}
          onClick={onOpen}
          onKeyDown={onOpen ? handleKeyDown : undefined}
          className={onOpen ? "-m-2 cursor-pointer rounded-lg p-2" : undefined}
        >
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 shrink-0 text-[var(--content-quiet)]" />
            <h3 className="min-w-0 truncate text-title-small text-[var(--content-strong)]">
              {documentName}
            </h3>
            {mimeType && (
              <span className="rounded-full bg-[var(--tag-bg-neutral)] px-2 py-0.5 text-body-small-default text-[var(--content-tertiary)]">
                {mimeType}
              </span>
            )}
            {onOpen && (
              <ArrowUpRight className="ml-auto h-3.5 w-3.5 shrink-0 text-[var(--content-faint)]" />
            )}
          </div>

          {content && (
            <pre className="mt-3 max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--surface-sunken)] p-3 text-body-small-default text-[var(--content-default)]">
              {content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
