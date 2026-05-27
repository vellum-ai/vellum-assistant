import {
  ArrowUp,
  Ellipsis,
  FileText,
  Globe,
  LayoutGrid,
  Pin,
  PinOff,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { type ChangeEvent, type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AppSummary } from "@/domains/chat/api/apps";
import type { DocumentSummary } from "@/domains/chat/api/documents";
import { ApiError } from "@/lib/api-errors";
import {
  deleteApp,
  getCachedAppHtml,
  importBundle,
  listApps,
  openApp,
  primeAppHtmlCache,
  shareApp,
} from "@/domains/chat/api/apps";
import { listDocuments } from "@/domains/chat/api/documents";
import { getVercelConfig, isCredentialError, publishApp } from "@/domains/chat/api/publish";
import { usePinnedAppsStore } from "@/domains/chat/pinned-apps-store";
import { useAssistantFeatureFlagStore } from "@/lib/feature-flags/assistant-feature-flag-store";
import { AppPreviewThumbnail } from "@/domains/chat/components/app-card";
import {
  BottomSheet,
  Button,
  ConfirmDialog,
  Input,
  Menu,
  PanelItem,
  toast,
} from "@vellum/design-library";
import { AppViewerContainer } from "@/domains/intelligence/components/apps/app-viewer-container";
import { VercelTokenDialog } from "@/components/vercel-token-dialog";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { cn } from "@/utils/misc";

function formatDate(epochMs: number): string {
  const date = new Date(epochMs);
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
}

interface LibraryAppCardProps {
  app: AppSummary;
  assistantId: string;
  isPinned: boolean;
  onOpen: (appId: string) => void;
  onPin: (app: AppSummary) => void;
  onDelete?: (app: AppSummary) => void;
  onDeploy?: () => void;
  isOpening?: boolean;
  justImported?: boolean;
  onAnimationEnd?: () => void;
}

function LibraryAppCard({
  app,
  assistantId,
  isPinned,
  onOpen,
  onPin,
  onDelete,
  onDeploy,
  isOpening,
  justImported,
  onAnimationEnd,
}: LibraryAppCardProps) {
  const [isSharing, setIsSharing] = useState(false);
  const loadHtml = useCallback(
    () => getCachedAppHtml(assistantId, app.id),
    [assistantId, app.id],
  );
  const handleShare = useCallback(async () => {
    if (isSharing) return;
    setIsSharing(true);
    try {
      await shareApp(assistantId, app.id, app.name);
      toast.success("App exported", { description: `${app.name}.vellum` });
    } catch (err) {
      toast.error("Failed to share app", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setIsSharing(false);
    }
  }, [assistantId, app.id, app.name, isSharing]);

  const [menuOpen, setMenuOpen] = useState(false);
  const isMobile = useIsMobile();

  return (
    <div
      className={cn(
        "group relative flex flex-col gap-2",
        justImported && "animate-[card-entrance_400ms_ease-out]",
      )}
      onAnimationEnd={justImported ? onAnimationEnd : undefined}
    >
      <button
        type="button"
        onClick={() => onOpen(app.id)}
        className={cn(
          "relative w-full cursor-pointer overflow-hidden rounded-xl",
          "outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
        )}
      >
        <AppPreviewThumbnail
          name={app.name}
          icon={app.icon}
          loadHtml={loadHtml}
          isLoading={isOpening}
        />
      </button>

      <div
        className={cn(
          "absolute right-2 top-2 z-20 transition-opacity",
          "max-md:opacity-100",
          "md:group-hover:opacity-100 md:group-focus-within:opacity-100",
          menuOpen ? "opacity-100" : "md:opacity-0",
        )}
      >
        <LibraryAppCardActionsMenu
          appName={app.name}
          isPinned={isPinned}
          open={menuOpen}
          onOpenChange={setMenuOpen}
          onPin={() => onPin(app)}
          onDelete={onDelete ? () => onDelete(app) : undefined}
          onShare={handleShare}
          onDeploy={onDeploy}
          isMobile={isMobile}
        />
      </div>

      <button
        type="button"
        onClick={() => onOpen(app.id)}
        className="flex cursor-pointer flex-col gap-0.5 px-0.5 text-left outline-none"
      >
        <span className="truncate text-body-large-default text-[color:var(--content-emphasised)]">
          {app.name}
        </span>
        <span className="text-body-small-default text-[color:var(--content-tertiary)]">
          {formatDate(app.createdAt)}
        </span>
      </button>
    </div>
  );
}

interface LibraryDocumentCardProps {
  document: DocumentSummary;
  onOpen: (documentSurfaceId: string) => void;
}

function formatWordCount(count: number): string {
  return count === 1 ? "1 word" : `${count} words`;
}

function LibraryDocumentCard({ document, onOpen }: LibraryDocumentCardProps) {
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
          {formatDate(document.updatedAt)}
        </span>
      </button>
    </div>
  );
}

export interface LibraryViewProps {
  assistantId: string;
  assistantName?: string;
  /**
   * Optional page title rendered to the left of the Import action.
   * Used when LibraryView is the page's primary content (e.g. the
   * standalone /library route) so the title shares a row with Import.
   */
  title?: string;
  onNewConversation?: (initialMessage?: string) => void;
  onOpenDocument?: (documentSurfaceId: string) => void;
  onEditApp?: (app: { appId: string; dirName?: string; name: string; html: string }) => void;
  /**
   * If provided, clicking an app navigates instead of opening it inline.
   * The library's `/library/:appId` route renders {@link LibraryDetailPage}
   * for the dedicated detail view; this callback wires the list click to
   * that route. When omitted, the click falls back to the inline overlay.
   */
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
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");

  const [openedApp, setOpenedApp] = useState<{
    appId: string;
    dirName?: string;
    name: string;
    html: string;
  } | null>(null);
  const [openingAppId, setOpeningAppId] = useState<string | null>(null);
  const [appPendingDelete, setAppPendingDelete] = useState<AppSummary | null>(
    null,
  );
  const [isDeleting, setIsDeleting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [lastImportedAppId, setLastImportedAppId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDeploying, setIsDeploying] = useState(false);
  const [showTokenDialog, setShowTokenDialog] = useState(false);
  const [pendingDeployAppId, setPendingDeployAppId] = useState<string | null>(null);
  const [complexDeployApp, setComplexDeployApp] = useState<{ appId: string; name: string } | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchLibrary() {
      try {
        setLoading(true);
        setError(null);
        const [appsResult, docsResult] = await Promise.allSettled([
          listApps(assistantId),
          listDocuments(assistantId),
        ]);
        if (!cancelled) {
          if (appsResult.status === "fulfilled") {
            setApps(appsResult.value);
          }
          if (docsResult.status === "fulfilled") {
            setDocuments(docsResult.value);
          }
          if (
            appsResult.status === "rejected" &&
            docsResult.status === "rejected"
          ) {
            const isNotFound = (r: PromiseRejectedResult) =>
              r.reason instanceof ApiError && r.reason.status === 404;
            if (isNotFound(appsResult) && isNotFound(docsResult)) {
              setApps([]);
              setDocuments([]);
            } else {
              throw appsResult.reason;
            }
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load library",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchLibrary();
    return () => {
      cancelled = true;
    };
  }, [assistantId]);

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
      // When wired with a route-based open handler, navigate to the dedicated
      // detail page instead of opening inline. LibraryDetailPage handles the
      // openApp call + dedicated load/error UI, and the URL becomes the
      // shareable deep-link.
      if (onOpenApp) {
        onOpenApp(appId);
        return;
      }
      if (openingAppId) return;
      setOpeningAppId(appId);
      try {
        const result = await openApp(assistantId, appId);
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
    try {
      const html = await getCachedAppHtml(assistantId, appId);
      if (html.includes("vellum.fetch") || html.includes("vellum.sendAction") || html.includes("/v1/x/") || html.includes("/v1/apps/")) {
        const app = apps.find((a) => a.id === appId);
        setComplexDeployApp({ appId, name: app?.name ?? "this app" });
        return;
      }
    } catch {
      // If we can't check the HTML, proceed with the deploy anyway
    }
    setIsDeploying(true);
    try {
      const config = await getVercelConfig(assistantId);
      if (!config.hasToken) {
        setPendingDeployAppId(appId);
        setShowTokenDialog(true);
        setIsDeploying(false);
        return;
      }
      const result = await publishApp(assistantId, appId);
      if (!result.success) {
        if (isCredentialError(result)) {
          setPendingDeployAppId(appId);
          setShowTokenDialog(true);
        } else {
          toast.error("Failed to deploy", { description: result.error });
        }
      } else if (result.publicUrl) {
        toast.success("Deployed to Vercel", {
          description: result.publicUrl,
          action: {
            label: "Open",
            onClick: () => window.open(result.publicUrl, "_blank"),
          },
        });
      } else {
        toast.success("Deployed to Vercel");
      }
    } catch (err) {
      toast.error("Failed to deploy", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setIsDeploying(false);
    }
  }, [assistantId, isDeploying, apps]);

  const handleTokenSaved = useCallback(async () => {
    setShowTokenDialog(false);
    const appId = pendingDeployAppId;
    setPendingDeployAppId(null);
    if (!appId) return;
    setIsDeploying(true);
    try {
      const result = await publishApp(assistantId, appId);
      if (!result.success) {
        toast.error("Failed to deploy", { description: result.error });
      } else if (result.publicUrl) {
        toast.success("Deployed to Vercel", {
          description: result.publicUrl,
          action: { label: "Open", onClick: () => window.open(result.publicUrl, "_blank") },
        });
      } else {
        toast.success("Deployed to Vercel");
      }
    } catch (err) {
      toast.error("Failed to deploy", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setIsDeploying(false);
    }
  }, [assistantId, pendingDeployAppId]);

  const handlePinToggle = useCallback(
    (app: AppSummary) => togglePin(app),
    [togglePin],
  );

  const handleConfirmDelete = useCallback(async () => {
    const target = appPendingDelete;
    if (!target || isDeleting) return;
    setIsDeleting(true);
    try {
      await deleteApp(assistantId, target.id);
      setApps((prev) => prev.filter((a) => a.id !== target.id));
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
      const updatedApps = await listApps(assistantId);
      setApps(updatedApps);
      setLastImportedAppId(result.appId);
      try {
        const appResult = await openApp(assistantId, result.appId);
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
          open={showTokenDialog}
          onOpenChange={setShowTokenDialog}
          assistantId={assistantId}
          onTokenSaved={handleTokenSaved}
        />
        <ConfirmDialog
          open={complexDeployApp !== null}
          title="This app needs a full deploy"
          message={`"${complexDeployApp?.name ?? ""}" uses backend services that won't work on a static Vercel page. ${assistantName ?? "Your assistant"} can deploy it properly with serverless functions.`}
          confirmLabel={`Let ${assistantName ?? "your assistant"} handle it`}
          onConfirm={() => {
            const appName = complexDeployApp?.name ?? "this app";
            setComplexDeployApp(null);
            onNewConversation?.(
              `Deploy my app "${appName}" to Vercel. It uses backend services that need serverless functions — please use the deploy-fullstack-vercel skill to handle it properly.`,
            );
          }}
          onCancel={() => setComplexDeployApp(null)}
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
        open={showTokenDialog}
        onOpenChange={setShowTokenDialog}
        assistantId={assistantId}
        onTokenSaved={handleTokenSaved}
      />

      <ConfirmDialog
        open={complexDeployApp !== null}
        title="This app needs a full deploy"
        message={`"${complexDeployApp?.name ?? ""}" uses backend services that won't work on a static Vercel page. ${assistantName ?? "Your assistant"} can deploy it properly with serverless functions.`}
        confirmLabel={`Let ${assistantName ?? "your assistant"} handle it`}
        onConfirm={() => {
          const appName = complexDeployApp?.name ?? "this app";
          setComplexDeployApp(null);
          onNewConversation?.(
            `Deploy my app "${appName}" to Vercel. It uses backend services that need serverless functions — please use the deploy-fullstack-vercel skill to handle it properly.`,
          );
        }}
        onCancel={() => setComplexDeployApp(null)}
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

export interface LibraryAppCardActionsMenuProps {
  appName: string;
  isPinned: boolean;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onPin: () => void;
  onDelete?: () => void;
  onShare?: () => void;
  onDeploy?: () => void;
  isMobile: boolean;
}

export function LibraryAppCardActionsMenu({
  appName,
  isPinned,
  open,
  onOpenChange,
  onPin,
  onDelete,
  onShare,
  onDeploy,
  isMobile,
}: LibraryAppCardActionsMenuProps) {
  if (isMobile) {
    return (
      <BottomSheet.Root open={open} onOpenChange={onOpenChange}>
        <BottomSheet.Trigger asChild>
          <Button
            variant="primary"
            size="compact"
            iconOnly={<Ellipsis />}
            aria-label="App actions"
            onClick={(e: MouseEvent) => e.stopPropagation()}
          />
        </BottomSheet.Trigger>
        <BottomSheet.Content>
          <BottomSheet.Header className="sr-only">
            <BottomSheet.Title>{appName}</BottomSheet.Title>
          </BottomSheet.Header>
          <BottomSheet.Body className="pt-0">
            <PanelItem
              icon={isPinned ? PinOff : Pin}
              label={isPinned ? "Unpin" : "Pin"}
              onSelect={() => {
                onOpenChange(false);
                onPin();
              }}
            />
            {onShare ? (
              <PanelItem
                icon={ArrowUp}
                label={
                  <span className="flex flex-col gap-0.5 overflow-visible whitespace-normal">
                    <span>Share</span>
                    <span className="text-body-small-default text-[var(--content-tertiary)]">
                      Export as .vellum file
                    </span>
                  </span>
                }
                onSelect={() => {
                  onOpenChange(false);
                  onShare();
                }}
              />
            ) : null}
            {onDeploy ? (
              <PanelItem
                icon={Globe}
                label={
                  <span className="flex flex-col gap-0.5 overflow-visible whitespace-normal">
                    <span>Deploy to Vercel</span>
                    <span className="text-body-small-default text-[var(--content-tertiary)]">
                      Publish as a static page
                    </span>
                  </span>
                }
                onSelect={() => {
                  onOpenChange(false);
                  onDeploy();
                }}
              />
            ) : null}
            {onDelete ? (
              <PanelItem
                icon={Trash2}
                label="Delete"
                onSelect={() => {
                  onOpenChange(false);
                  onDelete();
                }}
              />
            ) : null}
          </BottomSheet.Body>
        </BottomSheet.Content>
      </BottomSheet.Root>
    );
  }
  return (
    <Menu.Root open={open} onOpenChange={onOpenChange}>
      <Menu.Trigger asChild>
        <Button
          variant="primary"
          size="compact"
          iconOnly={<Ellipsis />}
          aria-label="App actions"
          onClick={(e: MouseEvent) => e.stopPropagation()}
        />
      </Menu.Trigger>
      <Menu.Content align="end" sideOffset={4}>
        <Menu.Item
          leftIcon={isPinned ? <PinOff size={14} /> : <Pin size={14} />}
          onSelect={() => onPin()}
          className="whitespace-nowrap"
        >
          {isPinned ? "Unpin" : "Pin"}
        </Menu.Item>
        {onShare ? (
          <Menu.Item
            leftIcon={<ArrowUp size={14} />}
            onSelect={() => onShare()}
            className="whitespace-nowrap"
          >
            Share
          </Menu.Item>
        ) : null}
        {onDeploy ? (
          <Menu.Item
            leftIcon={<Globe size={14} />}
            onSelect={() => onDeploy()}
            className="whitespace-nowrap"
          >
            Deploy to Vercel
          </Menu.Item>
        ) : null}
        {onDelete ? (
          <Menu.Item
            leftIcon={<Trash2 size={14} className="text-red-600" />}
            onSelect={() => onDelete()}
            className="whitespace-nowrap text-red-600 data-[highlighted]:text-red-700"
          >
            Delete
          </Menu.Item>
        ) : null}
      </Menu.Content>
    </Menu.Root>
  );
}
