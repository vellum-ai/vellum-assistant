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
import { type ChangeEvent, useCallback, useRef, useState } from "react";

import { DeployDialogs } from "@/components/deploy-dialogs";
import { DeleteAppDialog } from "@/components/delete-app-dialog";
import { LibraryDocumentCard } from "@/domains/library/components/library-document-card";
import { LibraryEmptyState } from "@/domains/library/components/library-empty-state";
import { LibraryGridSection } from "@/domains/library/components/library-grid-section";
import { useLibraryData } from "@/domains/library/use-library-data";
import { appsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { useDeployStore } from "@/stores/deploy-store";
import { useAppDelete } from "@/hooks/use-app-delete";
import { usePinnedAppsStore } from "@/stores/pinned-apps-store";
import type { AppSummary } from "@/types/app-types";
import { getCachedAppHtml } from "@/utils/app-html-cache";
import { importBundle } from "@/utils/import-bundle";
import { Button, Input, toast } from "@vellumai/design-library";

export interface LibraryViewProps {
  assistantId: string;
  assistantName?: string;
  title?: string;
  onNewConversation?: (initialMessage?: string) => void;
  onOpenDocument?: (documentSurfaceId: string) => void;
  onOpenApp: (appId: string) => void;
}

export function LibraryView({
  assistantId,
  assistantName,
  title,
  onNewConversation,
  onOpenDocument,
  onOpenApp,
}: LibraryViewProps) {
  const queryClient = useQueryClient();
  const togglePin = usePinnedAppsStore.use.togglePin();
  const pinnedAppIds = usePinnedAppsStore.use.pinnedAppIds();
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isImporting, setIsImporting] = useState(false);

  const handleImportBundle = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || isImporting) return;
      setIsImporting(true);
      try {
        const result = await importBundle(assistantId, file);
        await queryClient.invalidateQueries({
          queryKey: appsGetQueryKey({ path: { assistant_id: assistantId } }),
        });
        toast.success(result.name + " imported");
        onOpenApp(result.appId);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to import app",
        );
      } finally {
        setIsImporting(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [assistantId, isImporting, queryClient, onOpenApp],
  );

  // --- Deploy ---
  const handleDeploy = useCallback(
    async (appId: string) => {
      if (isDeploying) return;
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
    (app: AppSummary) => togglePin(app),
    [togglePin],
  );

  // --- Render: loading ---
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div
          className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--border-base)] border-t-[var(--primary-base)]"
          role="status"
          aria-label="Loading apps"
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
          Retry
        </button>
      </div>
    );
  }

  // --- Render: empty state ---
  if (apps.length === 0 && documents.length === 0) {
    return (
      <LibraryEmptyState
        fileInputRef={fileInputRef}
        isImporting={isImporting}
        onImportBundle={handleImportBundle}
        onNewConversation={
          onNewConversation ? () => onNewConversation() : undefined
        }
      />
    );
  }

  // --- Render: main library grid ---
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="mb-4 flex shrink-0 items-center justify-between gap-4">
        {title ? (
          <h1 className="text-title-large text-[var(--content-default)]">
            {title}
          </h1>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".vellum"
            className="hidden"
            onChange={handleImportBundle}
          />
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
            <span className="ml-1.5">Import</span>
          </Button>
        </div>
      </div>

      <div className="mb-6 shrink-0">
        <Input
          fullWidth
          type="text"
          placeholder="Search your library"
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
            <Search size={32} className="mb-4 text-[var(--content-tertiary)]" />
            <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
              No apps or documents matched &ldquo;{searchText}&rdquo;
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-8">
            <LibraryGridSection
              title="Pinned"
              apps={pinnedApps}
              assistantId={assistantId}
              pinnedAppIds={pinnedAppIds}
              onOpen={onOpenApp}
              onPin={handlePinToggle}
              onDelete={setAppPendingDelete}
              onDeploy={handleDeploy}
            />
            <LibraryGridSection
              title="Recents"
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
                  Documents
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
    </div>
  );
}
