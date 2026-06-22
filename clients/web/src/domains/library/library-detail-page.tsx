import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";

import { toast } from "@vellumai/design-library";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { AppViewerContainer } from "@/components/app-viewer-container";
import { appsByIdOpenPost } from "@/generated/daemon/sdk.gen";
import { useEditApp } from "@/hooks/use-edit-app";
import { primeAppHtmlCache } from "@/utils/app-html-cache";
import { routes } from "@/utils/routes";
import { shareApp } from "@/utils/share-app";

interface LoadedApp {
  appId: string;
  dirName?: string;
  name: string;
  html: string;
}

export function LibraryDetailPage() {
  const { appId } = useParams<{ appId: string }>();
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();

  const [app, setApp] = useState<LoadedApp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSharing, setIsSharing] = useState(false);
  const requestRef = useRef<string | null>(null);

  useEffect(() => {
    if (!appId) return;
    requestRef.current = appId;
    setApp(null);
    setError(null);

    appsByIdOpenPost({
      path: { assistant_id: assistantId, id: appId },
      throwOnError: true,
    })
      .then(({ data: result }) => {
        if (requestRef.current !== appId) return;
        primeAppHtmlCache(assistantId, result.appId, result.html);
        setApp({
          appId: result.appId,
          dirName: result.dirName,
          name: result.name,
          html: result.html,
        });
      })
      .catch((err) => {
        if (requestRef.current !== appId) return;
        setError(err instanceof Error ? err.message : "Failed to open app");
      });

    return () => {
      requestRef.current = null;
    };
  }, [assistantId, appId]);

  const handleClose = useCallback(() => {
    void navigate(routes.library.root);
  }, [navigate]);

  const editApp = useEditApp();
  const handleEdit = useCallback(() => {
    if (app) editApp(app);
  }, [app, editApp]);

  const handleShare = useCallback(async () => {
    if (!app || isSharing) return;
    setIsSharing(true);
    try {
      await shareApp(assistantId, app.appId, app.name);
      toast.success("App exported", { description: `${app.name}.vellum` });
    } catch (err) {
      toast.error("Failed to share app", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setIsSharing(false);
    }
  }, [assistantId, app, isSharing]);

  if (!appId) return null;

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          {error}
        </p>
        <button
          type="button"
          onClick={handleClose}
          className="text-body-medium-default text-[var(--primary-base)] underline"
        >
          Back to Library
        </button>
      </div>
    );
  }

  if (!app) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-[var(--content-tertiary)]" />
      </div>
    );
  }

  return (
    <AppViewerContainer
      appId={app.appId}
      appName={app.name}
      html={app.html}
      assistantId={assistantId}
      onClose={handleClose}
      onEdit={handleEdit}
      onShare={handleShare}
      isSharing={isSharing}
      enableFullscreen
    />
  );
}
