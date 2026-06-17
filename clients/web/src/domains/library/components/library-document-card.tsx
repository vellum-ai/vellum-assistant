import { FileText } from "lucide-react";

import type { DocumentSummary } from "@/types/document-types";
import { cn } from "@/utils/misc";
import { formatFriendlyDate } from "@/utils/format-date";

function formatWordCount(count: number): string {
  return count === 1 ? "1 word" : `${count} words`;
}

interface LibraryDocumentCardProps {
  document: DocumentSummary;
  onOpen: (documentSurfaceId: string) => void;
}

export function LibraryDocumentCard({ document, onOpen }: LibraryDocumentCardProps) {
  return (
    <div className="group relative flex flex-col gap-2">
      <button
        type="button"
        onClick={() => onOpen(document.surfaceId)}
        className={cn(
          "relative flex w-full cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden rounded-xl border border-[var(--border-base)] bg-[var(--surface-base)]",
          "aspect-[16/10]",
          "outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
        )}
      >
        <FileText size={34} className="text-[var(--content-tertiary)]" />
        <span className="text-body-small-default text-[var(--content-tertiary)]">
          {formatWordCount(document.wordCount)}
        </span>
      </button>

      <button
        type="button"
        onClick={() => onOpen(document.surfaceId)}
        className="flex cursor-pointer flex-col gap-0.5 px-0.5 text-left outline-none"
      >
        <span className="truncate text-body-large-default text-[color:var(--content-emphasised)]">
          {document.title}
        </span>
        <span className="text-body-small-default text-[color:var(--content-tertiary)]">
          {formatFriendlyDate(new Date(document.updatedAt))}
        </span>
      </button>
    </div>
  );
}
