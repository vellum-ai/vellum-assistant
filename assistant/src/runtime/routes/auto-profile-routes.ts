/**
 * Auto profile routes.
 *
 * POST /v1/auto-profile/preview — which default profile the Auto profile
 * would pick for a draft the user has not sent yet.
 */
import { z } from "zod";

import { previewAutoProfile } from "../../daemon/auto-profile-router.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const MAX_DRAFT_CHARS = 20_000;

const previewRequestSchema = z.object({
  text: z.string().min(1).max(MAX_DRAFT_CHARS),
  conversationId: z
    .string()
    .describe(
      "Conversation the draft belongs to, for recent history. Omit for a new chat.",
    )
    .optional(),
});

const previewResponseSchema = z.object({
  /** The default profile key the draft would run on; null when the Auto
   *  profile is not available on this install. */
  profile: z.string().nullable(),
  outcome: z.enum(["routed", "unavailable", "timeout", "error", "fallback"]),
  confidence: z.number().optional(),
});

async function handlePreviewAutoProfile(
  args: RouteHandlerArgs,
): Promise<z.infer<typeof previewResponseSchema>> {
  const parsed = previewRequestSchema.safeParse(args.body ?? {});
  if (!parsed.success) {
    throw new BadRequestError(
      `text must be a non-empty string of at most ${MAX_DRAFT_CHARS} characters`,
    );
  }
  // The composer aborts a preview the moment the draft changes; carrying the
  // abort through stops the retired Jev call and keeps its late answer out
  // of the reuse cache.
  const route = await previewAutoProfile({
    text: parsed.data.text,
    ...(parsed.data.conversationId
      ? { conversationId: parsed.data.conversationId }
      : {}),
    ...(args.abortSignal ? { signal: args.abortSignal } : {}),
  });
  if (!route) {
    return { profile: null, outcome: "unavailable" };
  }
  return {
    profile: route.profile,
    outcome: route.outcome,
    ...(route.confidence !== undefined ? { confidence: route.confidence } : {}),
  };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "previewAutoProfile",
    endpoint: "auto-profile/preview",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Preview the Auto profile's pick for a draft",
    description:
      "Ask the Auto profile which default profile a draft message would run on, " +
      "using the conversation's recent history when one is given. The pick is " +
      "kept briefly so the turn that sends the same text reuses it. Spends one " +
      "Jev call per request.",
    tags: ["conversations"],
    requestBody: previewRequestSchema,
    responseBody: previewResponseSchema,
    handler: handlePreviewAutoProfile,
  },
];
