/**
 * Manages the inline app viewer lifecycle — opening, closing, and sharing.
 *
 * When `onOpenApp` is provided (navigation-based open), delegates to it.
 * Otherwise manages internal viewer state for embedded contexts.
 */

import { useCallback, useState } from "react";

import { appsByIdOpenPost } from "@/generated/daemon/sdk.gen";
import { primeAppHtmlCache } from "@/utils/app-html-cache";
import { useDeployStore } from "@/stores/deploy-store";
import { toast } from "@vellum/design-library";

export interface OpenedApp {
  appId: string;
  dirName?: string;
  name: string;
  html: string;
}

export function useAppViewer(
  assistantId: string,
  onOpenApp?: (appId: string) => void,
) {
  const [openedApp, setOpenedApp] = useState<OpenedApp | null>(null);
  const [openingAppId, setOpeningAppId] = useState<string | null>(null);

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
        setOpenedApp({
          appId: result.appId,
          dirName: result.dirName,
          name: result.name,
          html: result.html,
        });
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

  const handleShareOpenedApp = useCallback(() => {
    if (!openedApp) return;
    void useDeployStore.getState().shareApp(assistantId, openedApp.appId, openedApp.name);
  }, [assistantId, openedApp]);

  return {
    openedApp,
    setOpenedApp,
    openingAppId,
    handleOpenApp,
    handleClose,
    handleShareOpenedApp,
  };
}
