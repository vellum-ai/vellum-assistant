/**
 * Route definition for the stored-credential model-access probe.
 *
 * POST /v1/inference/provider-connections/:name/probe-model-access
 *
 * Diagnoses the two failure modes that look identical from the outside: a
 * credential the provider no longer accepts, and a credential the provider
 * accepts but that cannot reach the model a profile is configured with. Both
 * surface at inference time as an opaque provider error, and neither can be
 * distinguished by inspecting local config.
 *
 * The stored credential is never read here. The route resolves the
 * connection, derives the models its profiles reference, and hands the
 * credential account plus a credential-free request recipe to the credential
 * executor, which performs the provider call and returns verdicts only.
 */

import { z } from "zod";

import { getEffectiveProfiles } from "../../config/default-profile-catalog.js";
import { getConfigReadOnly } from "../../config/loader.js";
import { getDb } from "../../persistence/db-connection.js";
import { getConnection } from "../../providers/inference/connections.js";
import { buildModelListingRequest } from "../../providers/model-listing.js";
import { probeModelAccessAsync } from "../../security/secure-keys.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const ProbeRequestSchema = z.object({
  /**
   * Models to check. Defaults to every model the connection's profiles
   * reference, which is what makes the probe a one-step diagnosis.
   */
  models: z.array(z.string().min(1)).optional(),
});

const ModelVerdictSchema = z.object({
  model: z.string(),
  access: z.enum(["accessible", "not_accessible", "unknown"]),
  /** Profiles that route this model through the connection. */
  profiles: z.array(z.string()),
});

const ProbeResponseSchema = z.object({
  connection: z.string(),
  provider: z.string(),
  /**
   * Credential verdict. `unsupported` means the connection has no stored
   * provider credential to probe (keyless or platform auth) or the provider
   * exposes no model-listing endpoint.
   */
  outcome: z.enum([
    "valid",
    "invalid",
    "missing_credential",
    "inconclusive",
    "unsupported",
  ]),
  /** HTTP status the provider returned, when the listing call completed. */
  status: z.number().int().optional(),
  /** Redacted provider error text, or the reason the probe was not run. */
  detail: z.string().optional(),
  /** How many models the credential can reach in total. */
  accessibleModelCount: z.number().int().optional(),
  models: z.array(ModelVerdictSchema),
  /** One-line human-readable verdict. */
  summary: z.string(),
});

type ProbeResponse = z.infer<typeof ProbeResponseSchema>;

/**
 * The account holding a credential that can be sent to a provider's model
 * listing as-is, or the reason the connection's auth cannot be probed.
 *
 * Only `api_key` qualifies. An `oauth_subscription` credential is a ChatGPT
 * Codex access token that the inference path refreshes before use and sends to
 * the subscription endpoint, so probing the stored token would report a
 * refreshable token as invalid. `service_account` auth is rejected at
 * inference time, and `platform` and `none` store no provider credential.
 */
function credentialAccountFor(auth: {
  type: string;
  credential?: string;
}): { account: string } | { unsupported: string } {
  switch (auth.type) {
    case "api_key":
      return auth.credential
        ? { account: auth.credential }
        : { unsupported: "its api_key auth names no stored credential." };
    case "oauth_subscription":
      return {
        unsupported:
          "subscription access tokens are refreshed at inference time, so a probe of the stored token would not reflect what inference uses.",
      };
    default:
      return {
        unsupported: `its "${auth.type}" auth stores no provider credential a model listing can be called with.`,
      };
  }
}

/** Models each profile bound to this connection resolves to. */
function modelsReferencedByProfiles(
  connectionName: string,
): Map<string, string[]> {
  const profiles = getEffectiveProfiles(getConfigReadOnly().llm?.profiles);
  const byModel = new Map<string, string[]>();
  for (const [profileName, profile] of Object.entries(profiles)) {
    if (profile.provider_connection !== connectionName || !profile.model) {
      continue;
    }
    const existing = byModel.get(profile.model);
    if (existing) {
      existing.push(profileName);
    } else {
      byModel.set(profile.model, [profileName]);
    }
  }
  return byModel;
}

function summarize(response: Omit<ProbeResponse, "summary">): string {
  const { connection, outcome } = response;
  switch (outcome) {
    case "invalid":
      return `The credential stored for "${connection}" was rejected by the provider.`;
    case "missing_credential":
      return `No credential is stored for "${connection}".`;
    case "unsupported":
      return `Connection "${connection}" cannot be probed: ${response.detail ?? "no model listing is available for this provider."}`;
    case "inconclusive":
      return `The probe of "${connection}" was inconclusive: ${response.detail ?? "the provider did not answer."}`;
    case "valid": {
      const inaccessible = response.models
        .filter((m) => m.access === "not_accessible")
        .map((m) => m.model);
      if (inaccessible.length > 0) {
        return `The credential stored for "${connection}" is valid, but cannot access: ${inaccessible.join(", ")}.`;
      }
      if (response.models.some((m) => m.access === "unknown")) {
        return `The credential stored for "${connection}" is valid, but the provider's model listing could not be read, so model access is undetermined.`;
      }
      return `The credential stored for "${connection}" is valid and can reach every model checked.`;
    }
  }
}

function withSummary(response: Omit<ProbeResponse, "summary">): ProbeResponse {
  return { ...response, summary: summarize(response) };
}

export async function handleProbeModelAccess(
  args: RouteHandlerArgs = {},
): Promise<ProbeResponse> {
  const name = args.pathParams?.name ?? "";
  const { models: requestedModels } = ProbeRequestSchema.parse(args.body ?? {});

  const connection = getConnection(getDb(), name);
  if (!connection) {
    throw new NotFoundError(`Connection "${name}" not found.`);
  }

  const profilesByModel = modelsReferencedByProfiles(name);
  const models = requestedModels ?? [...profilesByModel.keys()];
  const verdicts = (
    access: "unknown" | "accessible" | "not_accessible",
  ): ProbeResponse["models"] =>
    models.map((model) => ({
      model,
      access,
      profiles: profilesByModel.get(model) ?? [],
    }));

  const unsupported = (detail: string): ProbeResponse =>
    withSummary({
      connection: name,
      provider: connection.provider,
      outcome: "unsupported",
      detail,
      models: verdicts("unknown"),
    });

  const credential = credentialAccountFor(connection.auth);
  if ("unsupported" in credential) {
    return unsupported(credential.unsupported);
  }

  const listing = buildModelListingRequest(
    connection.provider,
    connection.baseUrl,
  );
  if (!listing) {
    return unsupported(
      `provider "${connection.provider}" exposes no model-listing endpoint the probe can use.`,
    );
  }

  const result = await probeModelAccessAsync({
    account: credential.account,
    request: listing,
    models,
  });
  if (!result) {
    return withSummary({
      connection: name,
      provider: connection.provider,
      outcome: "inconclusive",
      detail: "The credential store could not run the probe.",
      models: verdicts("unknown"),
    });
  }

  return withSummary({
    connection: name,
    provider: connection.provider,
    outcome: result.outcome,
    ...(result.status !== undefined ? { status: result.status } : {}),
    ...(result.detail ? { detail: result.detail } : {}),
    ...(result.outcome === "valid"
      ? { accessibleModelCount: result.accessibleModels.length }
      : {}),
    models: result.models.map((verdict) => ({
      ...verdict,
      profiles: profilesByModel.get(verdict.model) ?? [],
    })),
  });
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "inference_provider_connection_probe_model_access",
    endpoint: "inference/provider-connections/:name/probe-model-access",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Probe a connection's stored credential against the provider",
    description:
      "Call the provider's model-listing endpoint with the credential stored for this connection and report whether the credential is still valid and whether each model can be reached with it. The credential is used inside the credential executor and is never returned. Defaults to the models the connection's profiles reference; pass `models` to check specific ids.",
    tags: ["inference"],
    pathParams: [{ name: "name", description: "Connection name" }],
    requestBody: ProbeRequestSchema,
    responseBody: ProbeResponseSchema,
    additionalResponses: { "404": { description: "Connection not found" } },
    handler: handleProbeModelAccess,
  },
];
