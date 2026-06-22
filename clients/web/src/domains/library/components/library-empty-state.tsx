/**
 * Empty state shown when the library has no apps or documents.
 * Provides entry points to start a conversation or import a .vellum bundle.
 */

import { LayoutGrid, Upload } from "lucide-react";
import { type ChangeEvent, type RefObject } from "react";

import { Button } from "@vellumai/design-library";

interface LibraryEmptyStateProps {
  fileInputRef: RefObject<HTMLInputElement | null>;
  isImporting: boolean;
  onImportBundle: (e: ChangeEvent<HTMLInputElement>) => void;
  onNewConversation?: () => void;
}

export function LibraryEmptyState({
  fileInputRef,
  isImporting,
  onImportBundle,
  onNewConversation,
}: LibraryEmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-4 py-24">
      <input
        ref={fileInputRef}
        type="file"
        accept=".vellum"
        className="hidden"
        onChange={onImportBundle}
      />
      <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-[var(--surface-base)]">
        <LayoutGrid size={32} className="text-[var(--content-tertiary)]" />
      </div>
      <h2 className="text-title-medium text-[var(--content-default)]">
        Your library is empty
      </h2>
      <p className="max-w-md text-center text-body-medium-lighter text-[color:var(--content-tertiary)]">
        Ask your assistant to build something, or import a shared app
      </p>
      <div className="flex flex-col items-center gap-3">
        {onNewConversation ? (
          <>
            <Button
              variant="primary"
              size="regular"
              onClick={onNewConversation}
            >
              New Conversation
            </Button>
            <span className="text-body-small-default text-[color:var(--content-tertiary)]">
              or
            </span>
          </>
        ) : null}
        <Button
          variant="outlined"
          size="regular"
          onClick={() => fileInputRef.current?.click()}
          disabled={isImporting}
        >
          {isImporting ? (
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
          ) : (
            <Upload size={14} />
          )}
          <span className="ml-1.5">Import .vellum File</span>
        </Button>
      </div>
    </div>
  );
}
