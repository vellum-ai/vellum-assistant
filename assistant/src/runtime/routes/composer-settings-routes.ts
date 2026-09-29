import { z } from "zod";

import {
  ComposerPreferencesPatchSchema,
  ComposerPreferencesSchema,
  readComposerPreferences,
  updateComposerPreferences,
} from "../../config/composer-preferences.js";
import { SYNC_TAGS } from "../../daemon/message-types/sync.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { resolveActorPrincipalIdForLocalGuardian } from "../local-actor-identity.js";
import { publishSyncInvalidation } from "../sync/sync-publisher.js";
import { BadRequestError, UnauthorizedError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const ResponseSchema = z.object({
  preferences: ComposerPreferencesSchema,
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
  return { preferences: readComposerPreferences(principalId) };
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
    summary: "Get the current user's composer preferences",
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
