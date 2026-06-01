import { resolveDefaultProfileKey } from "../../config/llm-resolver.js";
import { loadConfig } from "../../config/loader.js";
import {
  CALL_SITE_CATALOG,
  CALL_SITE_DOMAINS,
} from "../../config/schemas/call-site-catalog.js";
import type { LLMCallSite } from "../../config/schemas/llm.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition } from "./types.js";

async function handleGetCallSites() {
  const { llm } = loadConfig();
  return {
    domains: CALL_SITE_DOMAINS,
    callSites: CALL_SITE_CATALOG.map((entry) => ({
      ...entry,
      defaultProfile: resolveDefaultProfileKey(entry.id as LLMCallSite, llm),
    })),
  };
}

export interface LlmProfilesListResult {
  /** Sorted list of profile names defined in `llm.profiles`. */
  profiles: string[];
  /** The workspace-wide active profile name, if one is set. */
  activeProfile: string | null;
}

async function handleListProfiles(): Promise<LlmProfilesListResult> {
  const { llm } = loadConfig();
  const profiles = llm?.profiles ?? {};
  return {
    profiles: Object.keys(profiles).sort(),
    activeProfile:
      typeof llm?.activeProfile === "string" ? llm.activeProfile : null,
  };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "llm_call_sites_list",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    endpoint: "config/llm/call-sites",
    handler: handleGetCallSites,
    summary: "List LLM call sites",
    description:
      "Returns the full catalog of LLM call sites with display names, descriptions, and domain groupings. Used by clients to render the per-call-site override settings UI.",
    tags: ["config"],
  },
  {
    operationId: "llm_profiles_list",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    endpoint: "config/llm/profiles",
    handler: handleListProfiles,
    summary: "List defined LLM profiles",
    description:
      "Returns the sorted list of profile names defined in `llm.profiles` plus the workspace-wide active profile. Used to populate per-call profile dropdowns (e.g. memory router playground) without requiring the caller to type profile names.",
    tags: ["config"],
  },
];
