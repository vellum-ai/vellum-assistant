/**
 * Fetch subagent execution detail from the daemon.
 *
 * The daemon route schema declares `events: z.array(z.unknown())` so the
 * generated SDK types events as `Array<unknown>`. This module defines the
 * known runtime shape and casts to it.
 */

import * as Sentry from "@sentry/browser";

import { subagentsByIdGet } from "@/generated/daemon/sdk.gen";

// ---------------------------------------------------------------------------
// Types — mirrors `parseSubagentMessages()` in the daemon's
// subagents-routes.ts. Kept here because this fetch wrapper is the sole
// consumer and the SDK's `z.unknown()` erases the real shape.
// ---------------------------------------------------------------------------

export interface SubagentEvent {
  type: string;
  content: string;
  toolName?: string;
  isError?: boolean;
  messageId?: string;
  text?: string;
  result?: string;
  timestamp?: number;
}

export interface SubagentDetailResponse {
  subagentId: string;
  objective: string;
  status?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
  };
  events: SubagentEvent[];
}

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
