import { z } from "zod";

import { CALL_SITE_DEFAULTS } from "../../config/call-site-defaults.js";
import { getEffectiveProfilesForProvider } from "../../config/default-profile-catalog.js";
import { resolveDefaultProfileKey } from "../../config/llm-resolver.js";
import { loadConfig } from "../../config/loader.js";
import {
  CALL_SITE_CATALOG,
  CALL_SITE_DOMAINS,
} from "../../config/schemas/call-site-catalog.js";
import type { LLMCallSite } from "../../config/schemas/llm.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition } from "./types.js";

const callSiteDomainSchema = z.object({
  id: z.string(),
  displayName: z.string(),
});

const callSiteEntrySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string(),
  domain: z.string(),
  /** The effective winning profile key: includes per-call-site pins. */
  defaultProfile: z.string().optional(),
  /**
   * The code-owned `CALL_SITE_DEFAULTS` tier key, independent of pins and
   * tier remaps. Clients group call sites by tier with this; grouping by
   * `defaultProfile` would scatter pinned or remapped sites across their
   * winners. Profileless call sites report `balanced`: the resolver's
   * fallback anchor consults the balanced remap for them, so they follow
   * the Balanced tier like any balanced-keyed site.
   */
  shippedDefaultProfile: z.string().optional(),
});

const callSiteCatalogResponseSchema = z.object({
  domains: z.array(callSiteDomainSchema),
  callSites: z.array(callSiteEntrySchema),
});

async function handleGetCallSites() {
  const { llm } = loadConfig();
  return {
    domains: CALL_SITE_DOMAINS,
    callSites: CALL_SITE_CATALOG.map((entry) => ({
      ...entry,
      defaultProfile: resolveDefaultProfileKey(entry.id as LLMCallSite, llm),
      shippedDefaultProfile:
        CALL_SITE_DEFAULTS[entry.id]?.profile ?? "balanced",
    })),
  };
}

const llmProfilesListResponseSchema = z.object({
  /** Sorted list of profile names defined in `llm.profiles`. */
  profiles: z.array(z.string()),
  /** The workspace-wide active profile name, if one is set. */
  activeProfile: z.string().nullable(),
});

export type LlmProfilesListResult = z.infer<
  typeof llmProfilesListResponseSchema
>;

async function handleListProfiles(): Promise<LlmProfilesListResult> {
  const { llm } = loadConfig();
  const profiles = getEffectiveProfilesForProvider(
    llm?.profiles,
    llm?.defaultProvider ?? null,
  );
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
    responseBody: callSiteCatalogResponseSchema,
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
    responseBody: llmProfilesListResponseSchema,
  },
];
