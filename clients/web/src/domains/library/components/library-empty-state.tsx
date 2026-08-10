/**
 * Empty state shown when the library has no apps or documents.
 * Provides entry points to start a conversation or import a .vellum bundle.
 */

import { Download, LayoutGrid } from "lucide-react";
import { type ChangeEvent, type RefObject } from "react";

import { Button } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

interface LibraryEmptyStateProps {
  /**
   * File-picker `accept` filter. `undefined` leaves the picker unrestricted
   * (touch devices, where iOS ignores extension filters) — see
   * `LibraryView` for the platform rationale.
   */
  accept: string | undefined;
  fileInputRef: RefObject<HTMLInputElement | null>;
  isImporting: boolean;
  onImportBundle: (e: ChangeEvent<HTMLInputElement>) => void;
  onNewConversation?: () => void;
}

export function LibraryEmptyState({
  accept,
  fileInputRef,
  isImporting,
  onImportBundle,
  onNewConversation,
}: LibraryEmptyStateProps) {
  const { t } = useTranslation("library");
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-4 py-24">
      <input
        ref={fileInputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={onImportBundle}
      />
      <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-[var(--surface-base)]">
        <LayoutGrid size={32} className="text-[var(--content-tertiary)]" />
      </div>
      <h2 className="text-title-medium text-[var(--content-default)]">
        {t("libraryEmptyState.heading")}
      </h2>
      <p className="max-w-md text-center text-body-medium-lighter text-[color:var(--content-tertiary)]">
        {t("libraryEmptyState.body")}
      </p>
      <div className="flex flex-col items-center gap-3">
        {onNewConversation ? (
          <>
            <Button
              variant="primary"
              size="regular"
              onClick={onNewConversation}
            >
              {t("libraryEmptyState.newConversation")}
            </Button>
            <span className="text-body-small-default text-[color:var(--content-tertiary)]">
              {t("libraryEmptyState.separator")}
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
            <Download size={14} />
          )}
          <span className="ml-1.5">{t("libraryEmptyState.importFile")}</span>
        </Button>
      </div>
    </div>
  );
}
