#!/usr/bin/env bun

import {
  type HelperEnvelope,
  parseCliInput,
  printError,
  printJson,
  toBool,
} from "./lib/common.js";

export type InfluencerStep = "discover" | "enrich_profile" | "compare_shortlist";

export interface InfluencerIntentContext {
  hasCandidates?: boolean;
  hasShortlist?: boolean;
}

export interface InfluencerIntentInput extends HelperEnvelope<InfluencerIntentContext> {
  request?: string;
}

export interface InfluencerIntentResult {
  step: InfluencerStep;
  confidence: number;
  reasons: string[];
  suggestedNextAction: string;
}

function includesAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

export function classifyInfluencerIntent(
  input: InfluencerIntentInput,
): InfluencerIntentResult {
  const context = input.context ?? {};
  const request = [input.request, input.userIntent].filter(Boolean).join(" ").toLowerCase();

  const compareTerms = ["compare", "versus", "vs", "side by side", "top picks"];
  const enrichTerms = ["profile", "tell me more", "deep dive", "details", "analyze"];

  const reasons: string[] = [];

  if (includesAny(request, compareTerms) && (context.hasShortlist || context.hasCandidates)) {
    reasons.push("Request is asking for a comparison with an existing candidate set.");
    return {
      step: "compare_shortlist",
      confidence: 0.9,
      reasons,
      suggestedNextAction: "Run scoring + compare helper scripts on shortlisted profiles.",
    };
  }

  if (includesAny(request, enrichTerms) || /@[a-z0-9_.]{2,}/i.test(request)) {
    reasons.push("Request asks for profile-level detail.");
    return {
      step: "enrich_profile",
      confidence: 0.82,
      reasons,
      suggestedNextAction: "Open candidate profile pages and extract richer metadata.",
    };
  }

  reasons.push("Defaulting to discovery workflow.");
  return {
    step: "discover",
    confidence: 0.7,
    reasons,
    suggestedNextAction: "Run platform search flow, parse candidates, then rank shortlist.",
  };
}

async function main(): Promise<void> {
  try {
    const { args, payload } = await parseCliInput<InfluencerIntentInput>(
      process.argv.slice(2),
      {},
    );

    const request =
      (typeof args.request === "string" ? args.request : undefined) ?? payload.request;

    const context: InfluencerIntentContext = {
      ...(payload.context ?? {}),
      ...(args["has-candidates"] !== undefined
        ? { hasCandidates: toBool(args["has-candidates"]) }
        : {}),
      ...(args["has-shortlist"] !== undefined
        ? { hasShortlist: toBool(args["has-shortlist"]) }
        : {}),
    };

    const data = classifyInfluencerIntent({
      ...payload,
      request,
      context,
    });

    printJson({ ok: true, data });
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
  }
}

if (import.meta.main) {
  await main();
}
