import { z } from "zod";

import {
  ComposerPreferencesPatchSchema,
  ComposerPreferencesSchema,
  readComposerPreferences,
  updateComposerPreferences,
} from "../../config/composer-preferences.js";
import {
  getEffectiveProfilesForProvider,
  getUserSelectableProfilesForProvider,
} from "../../config/default-profile-catalog.js";
import { getConfig } from "../../config/loader.js";
import { SYNC_TAGS } from "../../daemon/message-types/sync.js";
import { profileCostWithFallback } from "../../providers/model-cost-tier.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { resolveActorPrincipalIdForLocalGuardian } from "../local-actor-identity.js";
import { publishSyncInvalidation } from "../sync/sync-publisher.js";
import { BadRequestError, UnauthorizedError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const ResponseSchema = z.object({
  preferences: ComposerPreferencesSchema,
  modeCosts: z.record(
    z.string(),
    z.object({
      kind: z.enum(["tier", "varies", "unknown"]),
      tier: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    }),
  ),
});

async function principalFor(args: RouteHandlerArgs): Promise<string> {
  const id = await resolveActorPrincipalIdForLocalGuardian(
    args.headers?.["x-vellum-actor-principal-id"]?.trim() || undefined,
  );
  if (!id) {
    throw new UnauthorizedError(
      "A signed-in user is required for composer preferences",
    );
  }
  return id;
}

function responseFor(principalId: string) {
  const { llm } = getConfig();
  const profiles = getUserSelectableProfilesForProvider(
    llm.profiles,
    llm.defaultProvider ?? null,
  );
  const effectiveProfiles = getEffectiveProfilesForProvider(
    llm.profiles,
    llm.defaultProvider ?? null,
  );
  return {
    preferences: readComposerPreferences(principalId),
    modeCosts: Object.fromEntries(
      Object.entries(profiles).map(([name, profile]) => [
        name,
        profileCostWithFallback(
          name,
          profile,
          effectiveProfiles,
          llm.pricingOverrides.length > 0,
        ),
      ]),
    ),
  };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "composer_settings_get",
    endpoint: "composer/settings",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary:
      "Get the current user's composer preferences and relative model costs",
    tags: ["settings"],
    responseBody: ResponseSchema,
    handler: async (args) => responseFor(await principalFor(args)),
  },
  {
    operationId: "composer_settings_patch",
    endpoint: "composer/settings",
    method: "PATCH",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Update the current user's composer preferences",
    tags: ["settings"],
    requestBody: ComposerPreferencesPatchSchema,
    responseBody: ResponseSchema,
    handler: async (args) => {
      const patch = ComposerPreferencesPatchSchema.safeParse(args.body);
      if (!patch.success) {
        throw new BadRequestError(patch.error.message);
      }
      const principalId = await principalFor(args);
      updateComposerPreferences(principalId, patch.data);
      await publishSyncInvalidation(
        [SYNC_TAGS.assistantComposerPreferences],
        args.headers?.["x-vellum-client-id"],
      );
      return responseFor(principalId);
    },
  },
];
