import type { Surface } from "@/domains/chat/types/types";

import { readDynamicPageAppId } from "@/domains/chat/transcript/response-artifacts";

/**
 * The app a `dynamic_page` surface names.
 *
 * Delegates to the artifact registry's reader, which is the single place that
 * knows the daemon has emitted both `appId` and `app_id`: the registry has to
 * resolve the same id to decide whether the surface is a pointer to an app, and
 * two implementations would drift.
 */
export function getDynamicPageAppId(
  surface: Pick<Surface, "data">,
): string | null {
  return readDynamicPageAppId(surface);
}
