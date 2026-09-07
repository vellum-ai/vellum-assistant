/**
 * Read the assistant-wide main-agent profile from GET /v1/config.
 * The personality page has no conversation, so only `llm.activeProfile`
 * is consulted (not a per-thread override). A disabled active entry is
 * treated as missing: the daemon skips that rung and resolves from a
 * lower-precedence profile.
 */

import { configGet } from "@/generated/daemon/sdk.gen";
import { assertHasResponse } from "@/utils/api-errors";

export interface MainAgentProfile {
  provider: string;
  model: string;
}

export async function resolveMainAgentProfile(
  assistantId: string,
): Promise<MainAgentProfile | null> {
  const { data, error, response } = await configGet({
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to fetch assistant config");
  if (!response.ok || !data) {
    throw new Error("Failed to fetch assistant config");
  }
  const active = data.llm?.activeProfile;
  if (!active) {
    return null;
  }
  const entry = data.llm?.profiles?.[active];
  if (!entry?.provider || !entry.model || entry.status === "disabled") {
    return null;
  }
  return { provider: entry.provider, model: entry.model };
}
