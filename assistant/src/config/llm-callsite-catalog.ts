import { CALL_SITE_CATALOG } from "./schemas/call-site-catalog.js";
import type { LLMCallSite } from "./schemas/llm.js";

const LLM_CALLSITE_LABELS = new Map<LLMCallSite, string>(
  CALL_SITE_CATALOG.map(({ id, displayName }) => [id, displayName]),
);

export function getLLMCallSiteLabel(callSite: LLMCallSite | string): string {
  return LLM_CALLSITE_LABELS.get(callSite as LLMCallSite) ?? String(callSite);
}
