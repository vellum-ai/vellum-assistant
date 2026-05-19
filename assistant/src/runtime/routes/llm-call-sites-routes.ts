import { resolveDefaultProfileKey } from "../../config/llm-resolver.js";
import { loadConfig } from "../../config/loader.js";
import { CALL_SITE_CATALOG, CALL_SITE_DOMAINS } from "../../config/schemas/call-site-catalog.js";
import type { LLMCallSite } from "../../config/schemas/llm.js";
import type { RouteDefinition } from "./types.js";

async function handleGetCallSites() {
  const { llm } = loadConfig();
  return {
    domains: CALL_SITE_DOMAINS,
    callSites: CALL_SITE_CATALOG.map((entry) => ({
      ...entry,
      defaultProfile: resolveDefaultProfileKey(
        entry.id as LLMCallSite,
        llm,
      ),
    })),
  };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "llm_call_sites_list",
    method: "GET",
    endpoint: "config/llm/call-sites",
    handler: handleGetCallSites,
    summary: "List LLM call sites",
    description:
      "Returns the full catalog of LLM call sites with display names, descriptions, and domain groupings. Used by clients to render the per-call-site override settings UI.",
    tags: ["config"],
  },
];
