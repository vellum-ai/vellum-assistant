/**
 * Export one app as a `.vellum` bundle and report how it went.
 *
 * Every menu that offers Share does the same three things: refuse a second
 * export while one is running, hand the app to {@link shareApp}, and raise a
 * toast either way. The copy is the caller's, because the two menus name the
 * action from their own catalogs.
 */

import { useCallback, useState } from "react";

import { toast } from "@vellumai/design-library";

import type { AppSummary } from "@/types/app-types";
import { shareApp } from "@/utils/share-app";

export interface ShareAppCopy {
  /** Toast title once the bundle has been handed off. */
  exported: string;
  /** Toast title when the export fails; the error's own message is the description. */
  failed: string;
}

export interface ShareAppHandle {
  share: () => Promise<void>;
  isSharing: boolean;
}

export function useShareApp(
  assistantId: string,
  app: Pick<AppSummary, "id" | "name">,
  { exported, failed }: ShareAppCopy,
): ShareAppHandle {
  const { id, name } = app;
  const [isSharing, setIsSharing] = useState(false);

  const share = useCallback(async () => {
    if (isSharing) {
      return;
    }
    setIsSharing(true);
    try {
      await shareApp(assistantId, id, name);
      toast.success(exported, { description: `${name}.vellum` });
    } catch (err) {
      toast.error(failed, {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setIsSharing(false);
    }
  }, [assistantId, id, name, isSharing, exported, failed]);

  return { share, isSharing };
}
