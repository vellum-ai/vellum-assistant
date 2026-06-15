import { configLlmCallsitesGet } from "@/generated/daemon/sdk.gen";
import type { ConfigLlmCallsitesGetResponse } from "@/generated/daemon/types.gen";

export type ScheduleCallSiteCatalog = ConfigLlmCallsitesGetResponse;

export async function fetchScheduleCallSiteCatalog(
  assistantId: string,
): Promise<ScheduleCallSiteCatalog> {
  const { data, response } = await configLlmCallsitesGet({
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  if (!response?.ok) {
    const text = await response
      ?.clone()
      .text()
      .catch(() => "");
    throw new Error(
      text || response?.statusText || "Failed to load LLM call-site metadata.",
    );
  }
  return data ?? { domains: [], callSites: [] };
}
