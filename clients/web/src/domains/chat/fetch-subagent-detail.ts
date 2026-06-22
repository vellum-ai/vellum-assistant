/**
 * Fetch subagent execution detail from the daemon.
 *
 * The response is validated at the network boundary against the canonical
 * `SubagentDetailResponseSchema`, so consumers receive a typed, trusted
 * shape instead of the SDK's pre-schema `unknown` events.
 */

import { captureError } from "@/lib/sentry/capture-error";
import {
  SubagentDetailResponseSchema,
  type SubagentDetailResponse,
} from "@vellumai/assistant-api";

import { subagentsByIdGet } from "@/generated/daemon/sdk.gen";

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
    const parsed = SubagentDetailResponseSchema.safeParse(data);
    if (!parsed.success) {
      captureError(parsed.error, { context: "fetchSubagentDetail" });
      return null;
    }
    return parsed.data;
  } catch (err) {
    captureError(err, { context: "fetchSubagentDetail" });
    return null;
  }
}
