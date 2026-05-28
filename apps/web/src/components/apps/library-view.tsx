/**
 * Library view — renders the user's apps and documents with search,
 * filtering, pinning, deploy, import, and delete capabilities.
 *
 * This component is a thin orchestrator: it composes domain hooks for
 * data, actions, and side effects, then delegates rendering to focused
 * sub-components.
 */

import { type ChangeEvent, useCallback } from "react";
import { Search, Upload } from "lucide-react";

import type { AppSummary } from "@/types/app-types";
import { getCachedAppHtml } from "@/utils/app-html-cache";
import { usePinnedAppsStore } from "@/stores/pinned-apps-store";
import { useDeployStore } from "@/stores/deploy-store";
import { useAssistantFeatureFlagStore } from "@/lib/feature-flags/assistant-feature-flag-store";
import { Button, Input } from "@vellum/design-library";
import { AppViewerContainer } from "@/components/apps/app-viewer-container";
import { DeployDialogs } from "@/components/deploy-dialogs";
import { LibraryDocumentCard } from "@/components/apps/library-document-card";
import { LibraryEmptyState } from "@/components/apps/library-empty-state";
import { LibraryGridSection } from "@/components/apps/library-grid-section";
import { DeleteAppDialog } from "@/components/apps/delete-app-dialog";
import { useLibraryData } from "@/components/apps/use-library-data";
import { useAppViewer } from "@/components/apps/use-app-viewer";
import { useAppDelete } from "@/components/apps/use-app-delete";
import { useAppImport } from "@/components/apps/use-app-import";

export interface LibraryViewProps {
  assistantId: string;
  assistantName?: string;
  title?: string;
  onNewConversation?: (initialMessage?: string) => void;
  onOpenDocument?: (documentSurfaceId: string) => void;
  onEditApp?: (app: { appId: string; dirName?: string; name: string; html: string }) => void;
  onOpenApp?: (appId: string) => void;
}

export function LibraryView({
  assistantId,
  assistantName,
  title,
  onNewConversation,
  onOpenDocument,
  onEditApp,
  onOpenApp,
}: LibraryViewProps) {
  const deployToVercel = useAssistantFeatureFlagStore.use.deployToVercel();
  const togglePin = usePinnedAppsStore.use.togglePin();
  const isDeploying = useDeployStore.use.isDeploying();
  const isSharing = useDeployStore.use.isSharing();

  const {
    apps,
    documents,
    filteredApps,
    pinnedApps,
    recentApps,
    filteredDocuments,
    pinnedAppIds,
    searchText,
    setSearchText,
    loading,
    error,
  } = useLibraryData(assistantId);

  const {
    openedApp,
    setOpenedApp,
    openingAppId,
    handleOpenApp,
    handleClose,
    handleShareOpenedApp,
  } = useAppViewer(assistantId, onOpenApp);

  const {
    appPendingDelete,
    setAppPendingDelete,
    isDeleting,
    handleConfirmDelete,
    handleCancelDelete,
  } = useAppDelete(assistantId);

  const {
    fileInputRef,
    isImporting,
    lastImportedAppId,
    clearLastImported,
    handleImportBundle,
  } = useAppImport(assistantId, setOpenedApp);

  const handleDeploy = useCallback(async (appId: string) => {
    if (isDeploying) return;
    const app = apps.find((a) => a.id === appId);
    const appName = app?.name ?? "this app";
    try {
      const html = await getCachedAppHtml(assistantId, appId);
      void useDeployStore.getState().deployApp(assistantId, appId, appName, html);
    } catch {
      void useDeployStore.getState().deployApp(assistantId, appId, appName, "");
    }
  }, [assistantId, isDeploying, apps]);

  const handlePinToggle = useCallback(
    (app: AppSummary) => togglePin(app),
    [togglePin],
  );

  // --- Render: opened app viewer ---
  if (openedApp) {
    return (
      <>
        <AppViewerContainer
          appId={openedApp.appId}
          appName={openedApp.name}
          html={openedApp.html}
          assistantId={assistantId}
          onClose={handleClose}
          onEdit={onEditApp ? () => onEditApp(openedApp) : undefined}
          onShare={handleShareOpenedApp}
          isSharing={isSharing}
          onDeploy={deployToVercel ? () => handleDeploy(openedApp.appId) : undefined}
          isDeploying={isDeploying}
        />
        <DeployDialogs
          assistantId={assistantId}
          assistantName={assistantName}
          onStartConversation={onNewConversation}
        />
      </>
    );
  }

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
        onNewConversation={onNewConversation ? () => onNewConversation() : undefined}
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
              <Upload size={14} />
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
          onChange={(e: ChangeEvent<HTMLInputElement>) => setSearchText(e.target.value)}
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
              openingAppId={openingAppId}
              lastImportedAppId={lastImportedAppId}
              onOpen={handleOpenApp}
              onPin={handlePinToggle}
              onDelete={setAppPendingDelete}
              onDeploy={deployToVercel ? handleDeploy : undefined}
              onAnimationEnd={clearLastImported}
            />
            <LibraryGridSection
              title="Recents"
              apps={recentApps}
              assistantId={assistantId}
              pinnedAppIds={pinnedAppIds}
              openingAppId={openingAppId}
              lastImportedAppId={lastImportedAppId}
              onOpen={handleOpenApp}
              onPin={handlePinToggle}
              onDelete={setAppPendingDelete}
              onDeploy={deployToVercel ? handleDeploy : undefined}
              onAnimationEnd={clearLastImported}
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
