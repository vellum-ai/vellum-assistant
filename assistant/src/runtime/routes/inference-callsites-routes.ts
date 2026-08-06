/**
 * Route definitions for read-only inference call-site resolution inspection.
 *
 * GET /v1/inference/callsites        — effective resolution for every call site
 * GET /v1/inference/callsites/:site  — resolution detail + chain for one site
 *
 * These expose what `resolveCallSiteConfig` / `selectWinningProfile` already
 * compute so the assistant can inspect which profile wins each call site
 * without reading raw `llm.callSites.*` config paths. The detail view reuses
 * the resolver's own fallback reporting (`onResolutionFallback`) for the
 * resolution chain and the dispatch preflight (`preflightResolvedConfig`) for
 * the usability check — no explanation logic is duplicated here.
 */

import { z } from "zod";

import { CALL_SITE_DEFAULTS } from "../../config/call-site-defaults.js";
import {
  type ResolutionFallbackReason,
  resolveCallSiteConfig,
  selectWinningProfile,
} from "../../config/llm-resolver.js";
import { getConfigReadOnly } from "../../config/loader.js";
import { type LLMCallSite, LLMCallSiteEnum } from "../../config/schemas/llm.js";
import {
  ConnectionResolutionError,
  preflightResolvedConfig,
} from "../../providers/connection-resolution.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const sourceEnum = z.enum(["override", "active", "call_site", "default"]);

const callSiteSummarySchema = z
  .object({
    callSite: z.string(),
    profile: z.string().nullable(),
    label: z.string().nullable(),
    source: sourceEnum,
    provider: z.string(),
    model: z.string(),
    effort: z.string(),
    maxTokens: z.number(),
    /** Notable tuning: the resolved context-window input cap, when set. */
    maxInputTokens: z.number().optional(),
  })
  .meta({ id: "CallSiteResolutionSummary" });

const resolutionChainEntrySchema = z.object({
  requested: z.string(),
  reason: z.enum(["missing", "disabled", "incomplete"]),
});

const callSiteDetailSchema = z
  .object({
    callSite: z.string(),
    winner: z.object({
      profile: z.string().nullable(),
      label: z.string().nullable(),
      source: sourceEnum,
    }),
    resolved: z.object({
      provider: z.string(),
      model: z.string(),
      maxTokens: z.number(),
      effort: z.string(),
      temperature: z.number().nullable(),
      maxInputTokens: z.number().optional(),
    }),
    /** Rungs the resolver considered and skipped, oldest-first. */
    resolutionChain: z.array(resolutionChainEntrySchema),
    /** The shipped default fragment for this call site (code-owned). */
    shippedDefault: z.record(z.string(), z.unknown()),
    /** The user's call-site override fragment, if any. */
    userPin: z.record(z.string(), z.unknown()).nullable(),
    /** Present when the preflight can statically prove dispatch would fail. */
    resolutionError: z
      .object({ reason: z.string(), message: z.string() })
      .optional(),
  })
  .meta({ id: "CallSiteResolutionDetail" });

function summarizeCallSite(
  callSite: LLMCallSite,
  llm: Parameters<typeof resolveCallSiteConfig>[1],
) {
  const selection = selectWinningProfile(callSite, llm, {});
  const resolved = resolveCallSiteConfig(callSite, llm, {});
  const label =
    typeof selection.entry?.label === "string" ? selection.entry.label : null;
  const maxInputTokens = resolved.contextWindow?.maxInputTokens;
  return {
    callSite,
    profile: selection.profileName,
    label,
    source: selection.source,
    provider: resolved.provider,
    model: resolved.model,
    effort: resolved.effort,
    maxTokens: resolved.maxTokens,
    ...(typeof maxInputTokens === "number" ? { maxInputTokens } : {}),
  };
}

function handleListCallSites() {
  const llm = getConfigReadOnly().llm;
  const callSites = LLMCallSiteEnum.options.map((callSite) =>
    summarizeCallSite(callSite, llm),
  );
  return { callSites };
}

async function handleGetCallSite({ pathParams = {} }: RouteHandlerArgs) {
  const site = (pathParams.site ?? "").trim();
  const parsedSite = LLMCallSiteEnum.safeParse(site);
  if (!parsedSite.success) {
    throw new BadRequestError(
      `Unknown call site "${site}". Valid call sites: ${LLMCallSiteEnum.options.join(", ")}.`,
    );
  }
  const callSite = parsedSite.data;
  const llm = getConfigReadOnly().llm;

  const resolutionChain: {
    requested: string;
    reason: ResolutionFallbackReason;
  }[] = [];
  const selection = selectWinningProfile(callSite, llm, {
    onResolutionFallback: ({ requested, reason }) => {
      resolutionChain.push({ requested, reason });
    },
  });
  const resolved = resolveCallSiteConfig(callSite, llm, {});

  let resolutionError: { reason: string; message: string } | undefined;
  try {
    await preflightResolvedConfig(resolved, {
      profileName: selection.profileName ?? undefined,
    });
  } catch (err) {
    if (err instanceof ConnectionResolutionError) {
      resolutionError = { reason: err.reason, message: err.message };
    } else {
      throw err;
    }
  }

  const maxInputTokens = resolved.contextWindow?.maxInputTokens;
  return {
    callSite,
    winner: {
      profile: selection.profileName,
      label:
        typeof selection.entry?.label === "string"
          ? selection.entry.label
          : null,
      source: selection.source,
    },
    resolved: {
      provider: resolved.provider,
      model: resolved.model,
      maxTokens: resolved.maxTokens,
      effort: resolved.effort,
      temperature: resolved.temperature ?? null,
      ...(typeof maxInputTokens === "number" ? { maxInputTokens } : {}),
    },
    resolutionChain,
    shippedDefault: CALL_SITE_DEFAULTS[callSite] as Record<string, unknown>,
    userPin: (llm.callSites?.[callSite] ?? null) as Record<
      string,
      unknown
    > | null,
    ...(resolutionError ? { resolutionError } : {}),
  };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "inference_callsites_list",
    endpoint: "inference/callsites",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List call-site resolutions",
    description:
      "Return the effective resolution for every LLM call site: the winning profile, its source (override / active / call-site pin / shipped default), and the resolved provider/model plus notable tuning.",
    tags: ["inference"],
    responseBody: z.object({ callSites: z.array(callSiteSummarySchema) }),
    handler: handleListCallSites,
  },
  {
    operationId: "inference_callsites_get",
    endpoint: "inference/callsites/:site",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get a call-site resolution detail",
    description:
      "Return the full resolution for one call site: the winner, the resolution chain (rungs considered and skipped), the shipped default fragment, the user's pin fragment, and a preflight-derived resolution error when dispatch would provably fail.",
    tags: ["inference"],
    pathParams: [{ name: "site", description: "LLM call-site id" }],
    responseBody: callSiteDetailSchema,
    additionalResponses: { "400": { description: "Unknown call site" } },
    handler: handleGetCallSite,
  },
];
