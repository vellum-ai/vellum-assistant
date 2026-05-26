/**
 * Read-only template endpoint used by hatch clients (the CLI today, the
 * desktop installer eventually) to materialise BYOK inference for a fresh
 * off-platform workspace WITHOUT duplicating profile/connection templates
 * client-side.
 *
 * GET /v1/inference/onboarding-templates/:provider
 *
 *   Returns the resolved connection + profile shapes that
 *   `seedInferenceProfiles`'s `isHatch && !isPlatform` branch would have
 *   written on the Assistant if it had been invoked with an overlay. The
 *   caller is expected to apply them via the regular write endpoints:
 *
 *     1. POST  /v1/inference/provider-connections          ← personalConnection
 *     2. PATCH /v1/inference/provider-connections/:name    ← each in managedConnectionsToDisable
 *     3. PUT   /v1/config/llm/profiles/:name               ← each in managedProfilesToDisable / userProfiles
 *     4. POST  /v1/config/set llm.activeProfile            ← activeProfile
 *     5. POST  /v1/config/set llm.profileOrder             ← profileOrder
 *
 *   This endpoint replaces the old `VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH`
 *   overlay mechanism for Docker hatches: clients can no longer hand the
 *   Assistant a file of pre-baked workspace config edits to apply on boot,
 *   but they can still get the canonical recipe from the Assistant itself.
 */

import { z } from "zod";

import { credentialKey } from "../../security/credential-key.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";
import {
  buildByokOnboardingTemplate,
  isProviderEligibleForByokOnboarding,
} from "../../config/byok-onboarding-templates.js";

const personalConnectionSchema = z.object({
  name: z.string(),
  provider: z.string(),
  label: z.string(),
  auth: z.object({
    type: z.literal("api_key"),
    credential: z.string(),
  }),
  status: z.literal("active"),
});

const managedConnectionPatchSchema = z.object({
  name: z.string(),
  auth: z.object({ type: z.literal("platform") }),
  status: z.literal("disabled"),
});

const onboardingTemplateResponseSchema = z.object({
  provider: z.string(),
  personalConnection: personalConnectionSchema,
  managedConnectionsToDisable: z.array(managedConnectionPatchSchema),
  managedProfilesToDisable: z.array(z.string()),
  userProfiles: z.record(z.string(), z.unknown()),
  activeProfile: z.string(),
  profileOrder: z.array(z.string()),
});

function handleGetOnboardingTemplates({ pathParams = {} }: RouteHandlerArgs) {
  const provider = (pathParams.provider ?? "").trim();
  if (!provider) {
    throw new BadRequestError("provider path parameter is required");
  }
  if (!isProviderEligibleForByokOnboarding(provider)) {
    throw new BadRequestError(
      `Provider "${provider}" is not eligible for BYOK onboarding via this endpoint. ` +
        `Use the regular /v1/inference/provider-connections + /v1/config/llm/profiles endpoints to set it up manually.`,
    );
  }
  return buildByokOnboardingTemplate(provider, {
    apiKeyCredential: credentialKey(provider, "api_key"),
  });
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "inference_onboarding_templates_get",
    endpoint: "inference/onboarding-templates/:provider",
    method: "GET",
    policyKey: "inference/onboarding-templates",
    summary: "Get BYOK onboarding templates for a provider",
    description:
      "Return the resolved provider-connection and inference-profile shapes a fresh BYOK hatch should write. The caller applies them via the regular POST/PATCH/PUT endpoints. Read-only — this endpoint never writes to the workspace.",
    tags: ["inference"],
    pathParams: [
      {
        name: "provider",
        description: "Provider id (e.g. `anthropic`, `openai`, `gemini`).",
      },
    ],
    responseBody: onboardingTemplateResponseSchema,
    additionalResponses: {
      "400": {
        description: "Unknown provider or provider not eligible for BYOK onboarding via this endpoint.",
      },
    },
    handler: handleGetOnboardingTemplates,
  },
];
