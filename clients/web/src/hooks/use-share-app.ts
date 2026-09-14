/**
 * Export one app as a `.vellum` bundle from a menu, refusing a second export
 * while one is running.
 *
 * The sequence itself is {@link shareAppWithToast}; this adds the guard the
 * menus need. The guard is a ref rather than state because neither menu draws
 * a busy affordance, and a ref keeps `share` stable across the export. A
 * surface that does draw one owns its own flag and calls the core function.
 */

import { useCallback, useRef } from "react";

import type { AppSummary } from "@/types/app-types";
import {
  shareAppWithToast,
  type ShareAppCopy,
} from "@/utils/share-app-with-toast";

export function useShareApp(
  assistantId: string,
  app: Pick<AppSummary, "id" | "name">,
  { exported, failed }: ShareAppCopy,
): () => Promise<void> {
  const { id, name } = app;
  const isSharingRef = useRef(false);

  const share = useCallback(async () => {
    if (isSharingRef.current) {
      return;
    }
    isSharingRef.current = true;
    try {
      await shareAppWithToast(assistantId, { id, name }, { exported, failed });
    } finally {
      isSharingRef.current = false;
    }
  }, [assistantId, id, name, exported, failed]);

  return share;
}
