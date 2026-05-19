import {
  CALL_SITE_CATALOG,
  CALL_SITE_DOMAINS,
  CALL_SITE_TIERS,
} from "../../config/schemas/call-site-catalog.js";
import type { RouteDefinition } from "./types.js";

async function handleGetCallSites() {
  return {
    tiers: CALL_SITE_TIERS,
    domains: CALL_SITE_DOMAINS,
    callSites: CALL_SITE_CATALOG,
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
      "Returns the full catalog of LLM call sites with display names, descriptions, tier/domain groupings, and routing metadata. Used by clients to render per-call-site override settings UI.",
    tags: ["config"],
  },
];
