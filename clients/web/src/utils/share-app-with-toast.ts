/**
 * Export one app as a `.vellum` bundle and raise a toast either way.
 *
 * Every surface that offers Share does the same two things: hand the app to
 * {@link shareApp}, then report the outcome. The copy is the caller's, because
 * each menu names the action from its own catalog.
 *
 * Re-entrancy is the caller's too. A caller that only has to refuse a second
 * export guards with a ref (`useShareApp`); one that also renders a busy
 * affordance keeps the flag it draws from (the deploy store, the library
 * detail page).
 */

import { toast } from "@vellumai/design-library";

import { captureError } from "@/lib/sentry/capture-error";
import type { AppSummary } from "@/types/app-types";
import { shareApp } from "@/utils/share-app";

export interface ShareAppCopy {
  /** Toast title once the bundle has been handed off. */
  exported: string;
  /** Toast title when the export fails; the error's own message is the description. */
  failed: string;
}

export async function shareAppWithToast(
  assistantId: string,
  app: Pick<AppSummary, "id" | "name">,
  { exported, failed }: ShareAppCopy,
): Promise<void> {
  try {
    await shareApp(assistantId, app.id, app.name);
    toast.success(exported, { description: `${app.name}.vellum` });
  } catch (err) {
    captureError(err, { context: "shareAppWithToast" });
    toast.error(failed, {
      description: err instanceof Error ? err.message : undefined,
    });
  }
}
