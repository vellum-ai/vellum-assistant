/**
 * Empty state shown when the library has no apps or documents.
 * Provides an entry point to start a conversation.
 */

import { LayoutGrid } from "lucide-react";

import { Button } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

interface LibraryEmptyStateProps {
  onNewConversation?: () => void;
}

export function LibraryEmptyState({
  onNewConversation,
}: LibraryEmptyStateProps) {
  const { t } = useTranslation("library");
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-4 py-24">
      <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-[var(--surface-base)]">
        <LayoutGrid size={32} className="text-[var(--content-tertiary)]" />
      </div>
      <h2 className="text-title-medium text-[var(--content-default)]">
        {t("libraryEmptyState.heading")}
      </h2>
      <p className="max-w-md text-center text-body-medium-lighter text-[color:var(--content-tertiary)]">
        {t("libraryEmptyState.body")}
      </p>
      {onNewConversation ? (
        <Button variant="primary" size="regular" onClick={onNewConversation}>
          {t("libraryEmptyState.newConversation")}
        </Button>
      ) : null}
    </div>
  );
}
