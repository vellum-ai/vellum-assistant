/**
 * Library view — renders the user's apps and documents with search,
 * filtering, pinning, deploy, import, and delete capabilities.
 *
 * Thin orchestrator: composes the data-fetching hook, delegates rendering
 * to focused sub-components, and owns action callbacks inline (per the
 * domains/home/ pattern — callbacks stay inline when they are single-consumer
 * and don't involve data-fetching composition).
 */

import { useQueryClient } from "@tanstack/react-query";
import { Download, Search } from "lucide-react";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { DeployDialogs } from "@/components/deploy-dialogs";
import { DeleteAppDialog } from "@/components/delete-app-dialog";
import { LibraryDocumentCard } from "@/domains/library/components/library-document-card";
import { LibraryEmptyState } from "@/domains/library/components/library-empty-state";
import { LibraryGridSection } from "@/domains/library/components/library-grid-section";
import { useLibraryData } from "@/domains/library/use-library-data";
import { useIntelligenceLayoutSlotsStore } from "@/components/layout/intelligence-layout-slots-store";
import { appsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { useDeployStore } from "@/stores/deploy-store";
import { useAppDelete } from "@/hooks/use-app-delete";
import { usePinnedApps } from "@/hooks/use-pinned-apps";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { AppSummary } from "@/types/app-types";
import { getCachedAppHtml } from "@/utils/app-html-cache";
import { importBundle } from "@/utils/import-bundle";
import { isPointerCoarse } from "@/utils/pointer";
import { Button, Input, toast } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

export interface LibraryViewProps {
  assistantId: string;
  assistantName?: string;
  onNewConversation?: (initialMessage?: string) => void;
  onOpenDocument?: (documentSurfaceId: string) => void;
  onOpenApp: (appId: string) => void;
}

export function LibraryView({
  assistantId,
  assistantName,
  onNewConversation,
  onOpenDocument,
  onOpenApp,
}: LibraryViewProps) {
  const { t } = useTranslation("library");
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const { togglePin, pinnedAppIds } = usePinnedApps(assistantId);
  const isDeploying = useDeployStore.use.isDeploying();

  const {
    apps,
    documents,
    filteredApps,
    pinnedApps,
    recentApps,
    filteredDocuments,
    searchText,
    setSearchText,
    loading,
    error,
  } = useLibraryData(assistantId);

  // --- Delete state (shared flow, see use-app-delete.ts) ---
  const {
    pendingDelete: appPendingDelete,
    isDeleting,
    requestDelete: setAppPendingDelete,
    confirmDelete: handleConfirmDelete,
    cancelDelete: handleCancelDelete,
  } = useAppDelete(assistantId);

  // --- Import state ---
  // iOS Safari/WKWebView (including iOS Chrome) doesn't implement `accept`
  // with filename extensions, so a `.vellum` filter makes the custom-extension
  // bundle non-selectable in the file picker there. Constrain the picker to
  // `.vellum` only on fine-pointer (desktop) devices; touch devices get an
  // unrestricted picker and rely on the server's bundle validation.
  // https://github.com/mdn/browser-compat-data/issues/26043
  const [bundleAccept] = useState<string | undefined>(() =>
    isPointerCoarse() ? undefined : ".vellum",
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isImporting, setIsImporting] = useState(false);

  const handleImportBundle = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || isImporting) {
        return;
      }
      setIsImporting(true);
      try {
        const result = await importBundle(assistantId, file);
        await queryClient.invalidateQueries({
          queryKey: appsGetQueryKey({ path: { assistant_id: assistantId } }),
        });
        toast.success(t("libraryView.imported", { name: result.name }));
        onOpenApp(result.appId);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : t("libraryView.importFailed"),
        );
      } finally {
        setIsImporting(false);
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      }
    },
    [assistantId, isImporting, queryClient, onOpenApp, t],
  );

  // --- Deploy ---
  const handleDeploy = useCallback(
    async (appId: string) => {
      if (isDeploying) {
        return;
      }
      const app = apps.find((a) => a.id === appId);
      const appName = app?.name ?? "this app";
      try {
        const html = await getCachedAppHtml(assistantId, appId);
        void useDeployStore
          .getState()
          .deployApp(assistantId, appId, appName, html);
      } catch {
        void useDeployStore
          .getState()
          .deployApp(assistantId, appId, appName, "");
      }
    },
    [assistantId, isDeploying, apps],
  );

  const handlePinToggle = useCallback(
    (app: AppSummary) => togglePin(app.id),
    [togglePin],
  );

  // --- Header action ---
  // Import is the only way a `.vellum` recipient gets their first app, so it
  // stays reachable on the empty library as well as the populated one. It
  // sits on the layout's heading row, to the right of the "Library" title,
  // rather than on a row of its own above the search field; the file input
  // it opens stays down in the body, so the click reaches a mounted input.
  // Registered through the layout's slot store because the heading is the
  // layout's, not this view's (see IntelligenceLayout).
  const setHeaderTrailing =
    useIntelligenceLayoutSlotsStore.use.setHeaderTrailing();
  const showsImport = !loading && !error;
  useEffect(() => {
    if (!showsImport) {
      setHeaderTrailing(null);
      return;
    }
    const importIcon = isImporting ? (
      <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
    ) : (
      <Download aria-hidden />
    );
    setHeaderTrailing(
      isMobile ? (
        <Button
          variant="ghost"
          iconOnly={importIcon}
          aria-label={t("libraryView.import")}
          tooltip={t("libraryView.import")}
          className="rounded-full max-md:bg-[var(--surface-active)]"
          onClick={() => fileInputRef.current?.click()}
          disabled={isImporting}
        />
      ) : (
        <Button
          variant="outlined"
          size="regular"
          onClick={() => fileInputRef.current?.click()}
          disabled={isImporting}
        >
          {importIcon}
          <span className="ml-1.5">{t("libraryView.import")}</span>
        </Button>
      ),
    );
    return () => {
      setHeaderTrailing(null);
    };
  }, [isMobile, showsImport, isImporting, setHeaderTrailing, t]);

  // --- Render: loading ---
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div
          className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--border-base)] border-t-[var(--primary-base)]"
          role="status"
          aria-label={t("libraryView.loadingAria")}
        />
      </div>
    );
  }

  // --- Render: error ---
  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-4">
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          {error}
        </p>
        <button
          type="button"
          className="rounded-lg bg-[var(--primary-base)] px-4 py-2 text-body-medium-default text-[var(--content-inset)] transition-colors hover:bg-[var(--primary-hover)]"
          onClick={() => window.location.reload()}
        >
          {t("libraryView.retry")}
        </button>
      </div>
    );
  }

  const isEmpty = apps.length === 0 && documents.length === 0;

  // --- Render: library ---
  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* The picker the header's Import button opens. Outside the
          empty/populated split so the button works on both. */}
      <input
        ref={fileInputRef}
        type="file"
        accept={bundleAccept}
        className="hidden"
        onChange={handleImportBundle}
      />

      {isEmpty ? (
        <div className="min-h-0 flex-1">
          <LibraryEmptyState
            onNewConversation={
              onNewConversation ? () => onNewConversation() : undefined
            }
          />
        </div>
      ) : (
        <>
          <div className="mb-6 shrink-0">
            <Input
              fullWidth
              type="text"
              placeholder={t("libraryView.searchPlaceholder")}
              value={searchText}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setSearchText(e.target.value)
              }
              leftIcon={<Search size={16} />}
            />
          </div>

          <div className="flex-1 overflow-y-auto">
            {filteredApps.length === 0 && filteredDocuments.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16">
                <Search
                  size={32}
                  className="mb-4 text-[var(--content-tertiary)]"
                />
                <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
                  {t("libraryView.noMatches", { query: searchText })}
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-8">
                <LibraryGridSection
                  title={t("libraryView.pinned")}
                  apps={pinnedApps}
                  assistantId={assistantId}
                  pinnedAppIds={pinnedAppIds}
                  onOpen={onOpenApp}
                  onPin={handlePinToggle}
                  onDelete={setAppPendingDelete}
                  onDeploy={handleDeploy}
                />
                <LibraryGridSection
                  title={t("libraryView.recents")}
                  apps={recentApps}
                  assistantId={assistantId}
                  pinnedAppIds={pinnedAppIds}
                  onOpen={onOpenApp}
                  onPin={handlePinToggle}
                  onDelete={setAppPendingDelete}
                  onDeploy={handleDeploy}
                />
                {filteredDocuments.length > 0 ? (
                  <section>
                    <h2 className="mb-4 text-body-small-emphasised text-[color:var(--content-secondary)]">
                      {t("libraryView.documents")}
                    </h2>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(max(220px,calc((100%-6rem)/5)),1fr))] gap-6">
                      {filteredDocuments.map((doc) => (
                        <LibraryDocumentCard
                          key={doc.surfaceId}
                          document={doc}
                          onOpen={(documentSurfaceId) => {
                            if (onOpenDocument) {
                              onOpenDocument(documentSurfaceId);
                            }
                          }}
                        />
                      ))}
                    </div>
                  </section>
                ) : null}
              </div>
            )}
          </div>

          <DeployDialogs
            assistantId={assistantId}
            assistantName={assistantName}
            onStartConversation={onNewConversation}
          />

          <DeleteAppDialog
            app={appPendingDelete}
            isDeleting={isDeleting}
            onConfirm={handleConfirmDelete}
            onCancel={handleCancelDelete}
          />
        </>
      )}
    </div>
  );
}
