/**
 * Manages the .vellum bundle import flow — file selection, upload, and
 * post-import app opening.
 *
 * After a successful import, attempts to open the new app automatically.
 * Falls back to a "imported but couldn't open" warning toast.
 */

import { type ChangeEvent, useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { appsByIdOpenPost } from "@/generated/daemon/sdk.gen";
import { appsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { importBundle } from "@/utils/import-bundle";
import { primeAppHtmlCache } from "@/utils/app-html-cache";
import { toast } from "@vellum/design-library";
import type { OpenedApp } from "@/components/apps/use-app-viewer";

export function useAppImport(
  assistantId: string,
  onAppOpened: (app: OpenedApp) => void,
) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isImporting, setIsImporting] = useState(false);
  const [lastImportedAppId, setLastImportedAppId] = useState<string | null>(null);

  const handleImportBundle = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || isImporting) return;
    setIsImporting(true);
    try {
      const result = await importBundle(assistantId, file);
      await queryClient.invalidateQueries({
        queryKey: appsGetQueryKey({ path: { assistant_id: assistantId } }),
      });
      setLastImportedAppId(result.appId);
      try {
        const { data: appResult } = await appsByIdOpenPost({
          path: { assistant_id: assistantId, id: result.appId },
          throwOnError: true,
        });
        primeAppHtmlCache(assistantId, appResult.appId, appResult.html);
        onAppOpened({
          appId: appResult.appId,
          dirName: appResult.dirName,
          name: appResult.name,
          html: appResult.html,
        });
        setLastImportedAppId(null);
        toast.success(result.name + " imported");
      } catch {
        toast.warning("App imported", {
          description: "Imported successfully but couldn't open automatically",
        });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to import app");
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [assistantId, isImporting, queryClient, onAppOpened]);

  const clearLastImported = useCallback(() => {
    setLastImportedAppId(null);
  }, []);

  return {
    fileInputRef,
    isImporting,
    lastImportedAppId,
    clearLastImported,
    handleImportBundle,
  };
}
