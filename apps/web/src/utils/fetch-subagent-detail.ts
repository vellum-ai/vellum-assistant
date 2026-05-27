/**
 * Fetch subagent execution detail from the daemon.
 *
 * The daemon route schema declares `events: z.array(z.unknown())` so the
 * generated SDK types events as `Array<unknown>`. This wrapper casts to
 * the known runtime shape (`SubagentDetailResponse`).
 */

import * as Sentry from "@sentry/browser";

import { subagentsByIdGet } from "@/generated/daemon/sdk.gen";
import type { SubagentDetailResponse } from "@/types/subagent-types";

export async function fetchSubagentDetail(
  assistantId: string,
  subagentId: string,
  conversationId: string,
): Promise<SubagentDetailResponse | null> {
  try {
    const { data, response } = await subagentsByIdGet({
      path: { assistant_id: assistantId, id: subagentId },
      query: { conversationId },
      throwOnError: false,
    });
    if (!response || !response.ok || !data) {
      return null;
    }
    return data as unknown as SubagentDetailResponse;
  } catch (err) {
    Sentry.captureException(err, { tags: { operation: "fetchSubagentDetail" } });
    return null;
  }
}
