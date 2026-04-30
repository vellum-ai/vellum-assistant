import { CALL_SITE_CATALOG } from "./schemas/call-site-catalog.js";
import type { LLMCallSite } from "./schemas/llm.js";

// Compatibility wrapper for existing usage display imports. Do not define
// labels here; call-site display metadata belongs in CALL_SITE_CATALOG.
const LLM_CALLSITE_LABELS = new Map<LLMCallSite, string>(
  CALL_SITE_CATALOG.map(({ id, displayName }) => [id, displayName]),
);

export function getLLMCallSiteLabel(callSite: LLMCallSite | string): string {
  return LLM_CALLSITE_LABELS.get(callSite as LLMCallSite) ?? String(callSite);
}
