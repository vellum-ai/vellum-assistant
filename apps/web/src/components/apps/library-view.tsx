import {
  LayoutGrid,
  Search,
  Upload,
} from "lucide-react";
import { type ChangeEvent, useCallback, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  appsByIdDeletePost,
  appsByIdOpenPost,
} from "@/generated/daemon/sdk.gen";
import {
  appsGetOptions,
  appsGetQueryKey,
  documentsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { AppSummary } from "@/types/app-types";
import { clearAppHtmlCache, getCachedAppHtml, primeAppHtmlCache } from "@/utils/app-html-cache";
import { importBundle } from "@/utils/import-bundle";
import { shareApp } from "@/utils/share-app";
import { usePinnedAppsStore } from "@/stores/pinned-apps-store";
import { useDeployStore } from "@/stores/deploy-store";
import { useAssistantFeatureFlagStore } from "@/lib/feature-flags/assistant-feature-flag-store";
import {
  Button,
  ConfirmDialog,
  Input,
  toast,
} from "@vellum/design-library";
import { AppViewerContainer } from "@/components/apps/app-viewer-container";
import { VercelTokenDialog } from "@/components/vercel-token-dialog";
import { LibraryAppCard } from "@/components/apps/library-app-card";
import { LibraryDocumentCard } from "@/components/apps/library-document-card";

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
  const pinnedAppIds = usePinnedAppsStore.use.pinnedAppIds();
  const togglePin = usePinnedAppsStore.use.togglePin();
  const queryClient = useQueryClient();

  // Deploy store — shared with chat-page for consistent deploy UX
  const isDeploying = useDeployStore.use.isDeploying();
  const isTokenDialogOpen = useDeployStore.use.isTokenDialogOpen();
  const complexDeployApp = useDeployStore.use.complexDeployApp();

  const { data: apps = [], isLoading: appsLoading, error: appsError } = useQuery({
    ...appsGetOptions({ path: { assistant_id: assistantId } }),
    select: (data) => data.apps,
  });
  const { data: documents = [], isLoading: docsLoading, error: docsError } = useQuery({
    ...documentsGetOptions({ path: { assistant_id: assistantId } }),
    select: (data) => data.documents,
  });
  const loading = appsLoading || docsLoading;
  const error = appsError && docsError
    ? (appsError instanceof Error ? appsError.message : "Failed to load library")
    : null;
  const [searchText, setSearchText] = useState("");

  const [openedApp, setOpenedApp] = useState<{
    appId: string;
    dirName?: string;
    name: string;
    html: string;
  } | null>(null);
  const [openingAppId, setOpeningAppId] = useState<string | null>(null);
  const [appPendingDelete, setAppPendingDelete] = useState<AppSummary | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [lastImportedAppId, setLastImportedAppId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const filteredApps = useMemo(() => {
    if (!searchText.trim()) return apps;
    const lower = searchText.toLowerCase();
    return apps.filter(
      (a) =>
        a.name.toLowerCase().includes(lower) ||
        a.description?.toLowerCase().includes(lower),
    );
  }, [apps, searchText]);

  const pinnedApps = useMemo(
    () => filteredApps.filter((a) => pinnedAppIds.has(a.id)).sort((a, b) => b.createdAt - a.createdAt),
    [filteredApps, pinnedAppIds],
  );

  const recentApps = useMemo(
    () => filteredApps.filter((a) => !pinnedAppIds.has(a.id)).sort((a, b) => b.createdAt - a.createdAt),
    [filteredApps, pinnedAppIds],
  );

  const filteredDocuments = useMemo(() => {
    if (!searchText.trim()) return documents;
    const lower = searchText.toLowerCase();
    return documents.filter((d) => d.title.toLowerCase().includes(lower));
  }, [documents, searchText]);

  const handleOpenApp = useCallback(
    async (appId: string) => {
      if (onOpenApp) {
        onOpenApp(appId);
        return;
      }
      if (openingAppId) return;
      setOpeningAppId(appId);
      try {
        const { data: result } = await appsByIdOpenPost({
          path: { assistant_id: assistantId, id: appId },
          throwOnError: true,
        });
        primeAppHtmlCache(assistantId, result.appId, result.html);
        setOpenedApp({ appId: result.appId, dirName: result.dirName, name: result.name, html: result.html });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to open app");
      } finally {
        setOpeningAppId(null);
      }
    },
    [assistantId, openingAppId, onOpenApp],
  );

  const handleClose = useCallback(() => {
    setOpenedApp(null);
  }, []);

  const handleShareOpenedApp = useCallback(async () => {
    if (!openedApp || isSharing) return;
    setIsSharing(true);
    try {
      await shareApp(assistantId, openedApp.appId, openedApp.name);
      toast.success("App exported", { description: `${openedApp.name}.vellum` });
    } catch (err) {
      toast.error("Failed to share app", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setIsSharing(false);
    }
  }, [assistantId, openedApp, isSharing]);

  const handleDeploy = useCallback(async (appId: string) => {
    if (isDeploying) return;
    const app = apps.find((a) => a.id === appId);
    const appName = app?.name ?? "this app";
    try {
      const html = await getCachedAppHtml(assistantId, appId);
      void useDeployStore.getState().deployApp(assistantId, appId, appName, html);
    } catch {
      // If we can't fetch the HTML, try deploying anyway with empty HTML
      // (the store's complexity check will pass, and the server will handle it)
      void useDeployStore.getState().deployApp(assistantId, appId, appName, "");
    }
  }, [assistantId, isDeploying, apps]);

  const handlePinToggle = useCallback(
    (app: AppSummary) => togglePin(app),
    [togglePin],
  );

  const handleConfirmDelete = useCallback(async () => {
    const target = appPendingDelete;
    if (!target || isDeleting) return;
    setIsDeleting(true);
    try {
      await appsByIdDeletePost({
        path: { assistant_id: assistantId, id: target.id },
        throwOnError: true,
      });
      clearAppHtmlCache(assistantId, target.id);
      void queryClient.invalidateQueries({ queryKey: appsGetQueryKey({ path: { assistant_id: assistantId } }) });
      if (pinnedAppIds.has(target.id)) {
        togglePin(target);
      }
      setAppPendingDelete(null);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to delete app",
      );
    } finally {
      setIsDeleting(false);
    }
  }, [appPendingDelete, isDeleting, assistantId, pinnedAppIds, togglePin]);

  const handleImportBundle = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || isImporting) return;
    setIsImporting(true);
    try {
      const result = await importBundle(assistantId, file);
      await queryClient.invalidateQueries({ queryKey: appsGetQueryKey({ path: { assistant_id: assistantId } }) });
      setLastImportedAppId(result.appId);
      try {
        const { data: appResult } = await appsByIdOpenPost({
          path: { assistant_id: assistantId, id: result.appId },
          throwOnError: true,
        });
        primeAppHtmlCache(assistantId, appResult.appId, appResult.html);
        setOpenedApp({ appId: appResult.appId, dirName: appResult.dirName, name: appResult.name, html: appResult.html });
        setLastImportedAppId(null);
        toast.success(result.name + " imported");
      } catch {
        toast.warning("App imported", { description: "Imported successfully but couldn't open automatically" });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to import app");
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [assistantId, isImporting]);

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
        <VercelTokenDialog
          open={isTokenDialogOpen}
          onOpenChange={(open) => {
            if (!open) useDeployStore.getState().hideTokenDialog();
          }}
          assistantId={assistantId}
          onTokenSaved={() => {
            void useDeployStore.getState().deployAfterTokenSaved(assistantId);
          }}
        />
        <ConfirmDialog
          open={complexDeployApp !== null}
          title="This app needs a full deploy"
          message={`"${complexDeployApp?.name ?? ""}" uses backend services that won't work on a static Vercel page. ${assistantName ?? "Your assistant"} can deploy it properly with serverless functions.`}
          confirmLabel={`Let ${assistantName ?? "your assistant"} handle it`}
          onConfirm={() => {
            const appName = useDeployStore.getState().complexDeployApp?.name ?? "this app";
            useDeployStore.getState().setComplexDeployApp(null);
            onNewConversation?.(
              `Deploy my app "${appName}" to Vercel. It uses backend services that need serverless functions — please use the deploy-fullstack-vercel skill to handle it properly.`,
            );
          }}
          onCancel={() => useDeployStore.getState().setComplexDeployApp(null)}
        />
      </>
    );
  }

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

  if (apps.length === 0 && documents.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-4 py-24">
        <input
          ref={fileInputRef}
          type="file"
          accept=".vellum"
          className="hidden"
          onChange={handleImportBundle}
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
                onClick={() => onNewConversation?.()}
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

  const renderGrid = (items: AppSummary[]) => (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(max(220px,calc((100%-6rem)/5)),1fr))] gap-6">
      {items.map((app) => (
        <LibraryAppCard
          key={app.id}
          app={app}
          assistantId={assistantId}
          isPinned={pinnedAppIds.has(app.id)}
          onOpen={handleOpenApp}
          onPin={handlePinToggle}
          onDelete={setAppPendingDelete}
          isOpening={openingAppId === app.id}
          justImported={app.id === lastImportedAppId}
          onAnimationEnd={() => setLastImportedAppId(null)}
          onDeploy={deployToVercel ? () => handleDeploy(app.id) : undefined}
        />
      ))}
    </div>
  );

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
          onChange={(e) => setSearchText(e.target.value)}
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
            {pinnedApps.length > 0 ? (
              <section>
                <h2 className="mb-4 text-body-small-emphasised text-[color:var(--content-secondary)]">
                  Pinned
                </h2>
                {renderGrid(pinnedApps)}
              </section>
            ) : null}
            {recentApps.length > 0 ? (
              <section>
                <h2 className="mb-4 text-body-small-emphasised text-[color:var(--content-secondary)]">
                  Recents
                </h2>
                {renderGrid(recentApps)}
              </section>
            ) : null}
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

      <VercelTokenDialog
        open={isTokenDialogOpen}
        onOpenChange={(open) => {
          if (!open) useDeployStore.getState().hideTokenDialog();
        }}
        assistantId={assistantId}
        onTokenSaved={() => {
          void useDeployStore.getState().deployAfterTokenSaved(assistantId);
        }}
      />

      <ConfirmDialog
        open={complexDeployApp !== null}
        title="This app needs a full deploy"
        message={`"${complexDeployApp?.name ?? ""}" uses backend services that won't work on a static Vercel page. ${assistantName ?? "Your assistant"} can deploy it properly with serverless functions.`}
        confirmLabel={`Let ${assistantName ?? "your assistant"} handle it`}
        onConfirm={() => {
          const appName = useDeployStore.getState().complexDeployApp?.name ?? "this app";
          useDeployStore.getState().setComplexDeployApp(null);
          onNewConversation?.(
            `Deploy my app "${appName}" to Vercel. It uses backend services that need serverless functions — please use the deploy-fullstack-vercel skill to handle it properly.`,
          );
        }}
        onCancel={() => useDeployStore.getState().setComplexDeployApp(null)}
      />

      <ConfirmDialog
        open={appPendingDelete !== null}
        title="Delete app"
        message={
          appPendingDelete
            ? `"${appPendingDelete.name}" will be permanently removed.`
            : ""
        }
        confirmLabel={isDeleting ? "Deleting…" : "Delete"}
        destructive
        onConfirm={handleConfirmDelete}
        onCancel={() => {
          if (!isDeleting) setAppPendingDelete(null);
        }}
      />
    </div>
  );
}
