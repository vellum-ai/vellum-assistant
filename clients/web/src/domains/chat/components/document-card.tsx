/**
 * The affordance that stands for a document in the transcript: a primary
 * button naming it, a document glyph on the left and a chevron on the right,
 * held in its active state while that document is the one on screen.
 *
 * A document reaches the transcript two ways: the daemon's inline
 * `document_preview` surface (`DocumentPreviewSurface`) and the
 * end-of-response affordance the transcript derives from a turn's document
 * tool calls (`DocumentReopenLink`). Both draw through this component so
 * the two cannot drift into looking like different kinds of thing.
 */

import { Button } from "@vellumai/design-library";
import { ChevronRight, FileText } from "lucide-react";

export interface DocumentCardProps {
  /** Title to show for the document. */
  documentName: string;
  /** Optional MIME tag, shown as a chip beside the name. */
  mimeType?: string;
  /** Optional inline excerpt of the document's content. */
  content?: string;
  /** Opens the document. Omitted for a card that is not actionable. */
  onOpen?: () => void;
  /** The document is the one the viewer is currently showing. */
  isOpen?: boolean;
  /** Accessible name for the open gesture. */
  ariaLabel?: string;
  testId?: string;
}

export function DocumentCard({
  documentName,
  mimeType,
  content,
  onOpen,
  isOpen = false,
  ariaLabel,
  testId,
}: DocumentCardProps) {
  return (
    <div className="flex max-w-sm flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <Button
          variant="primary"
          active={isOpen}
          aria-pressed={onOpen ? isOpen : undefined}
          aria-label={onOpen ? ariaLabel : undefined}
          data-testid={testId}
          disabled={!onOpen}
          onClick={onOpen}
          leftIcon={<FileText />}
          rightIcon={<ChevronRight />}
          className="min-w-0 max-w-full"
        >
          {/* The button lays its label out as a flex item that will not
              shrink on its own, so a long document name would push the
              chevron out of the row rather than ellipsing. */}
          <span className="min-w-0 truncate">{documentName}</span>
        </Button>
        {mimeType && (
          <span className="shrink-0 rounded-full bg-[var(--tag-bg-neutral)] px-2 py-0.5 text-body-small-default text-[var(--content-tertiary)]">
            {mimeType}
          </span>
        )}
      </div>

      {content && (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3 text-body-small-default text-[var(--content-default)]">
          {content}
        </pre>
      )}
    </div>
  );
}
