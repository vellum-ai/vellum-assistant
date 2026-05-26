/**
 * Build the canonical BYOK onboarding recipe for a given provider.
 *
 * This module exposes a pure read-only view over the same template constants
 * that `seedInferenceProfiles` uses for its `isHatch && !isPlatform` branch.
 * The recipe is consumed by the `GET /v1/inference/onboarding-templates/:provider`
 * route, which hands it to hatch clients (today: the Docker hatch CLI) so they
 * can apply it via the regular write endpoints — no overlay file, no daemon
 * boot env-var.
 *
 * The shape is intentionally a *recipe*, not a snapshot of current workspace
 * state: it tells the caller exactly which writes to perform and in which
 * order, with each entry already shaped to fit the body schema of the target
 * endpoint. Tests live alongside this module — the route handler is a thin
 * wrapper.
 */

import {
  MANAGED_CONNECTION_NAMES,
  PROVIDERS_REQUIRING_BASE_URL_AND_MODELS,
} from "../providers/inference/connections.js";
import { VALID_CONNECTION_PROVIDERS } from "../providers/inference/auth.js";
import type { ProfileEntry } from "./schemas/llm.js";
import {
  MANAGED_PROFILE_NAMES,
  USER_PROFILE_TEMPLATES,
  materializeProfile,
  personalConnectionLabel,
} from "./seed-inference-profiles.js";

/**
 * The personal `${provider}-personal` provider-connection row a fresh BYOK
 * hatch should create. The `auth.credential` field references the CES secret
 * the CLI has already POSTed via `/v1/secrets` — the actual API key value
 * never appears in this response.
 */
export type PersonalConnectionTemplate = {
  name: string;
  provider: string;
  label: string;
  auth: { type: "api_key"; credential: string };
  status: "active";
};

/**
 * A single PATCH body the caller should send against
 * `/v1/inference/provider-connections/:name` to flip a managed connection
 * to `disabled`. The auth shape mirrors what the PATCH handler requires
 * (managed connections are locked to `{type:"platform"}`).
 */
export type ManagedConnectionDisablePatch = {
  name: string;
  auth: { type: "platform" };
  status: "disabled";
};

export type ByokOnboardingTemplate = {
  provider: string;
  personalConnection: PersonalConnectionTemplate;
  managedConnectionsToDisable: ManagedConnectionDisablePatch[];
  managedProfilesToDisable: string[];
  userProfiles: Record<string, ProfileEntry>;
  activeProfile: string;
  profileOrder: string[];
};

/**
 * A provider is eligible for BYOK onboarding via this endpoint when:
 *   - it appears in `VALID_CONNECTION_PROVIDERS` (the catalog is the source of
 *     truth), AND
 *   - it is not `ollama` (keyless local — no API key, no `${provider}-personal`
 *     connection to seed), AND
 *   - it is not in `PROVIDERS_REQUIRING_BASE_URL_AND_MODELS` (openai-compatible
 *     needs `base_url` + `models` from the user before any connection can be
 *     created — that has to be a different, interactive flow).
 *
 * Mirrors the same gate the seeder applies at hatch time (see
 * `seed-inference-profiles.ts` `hatchProvider` check).
 */
export function isProviderEligibleForByokOnboarding(provider: string): boolean {
  if (!VALID_CONNECTION_PROVIDERS.includes(provider)) return false;
  if (provider === "ollama") return false;
  if (PROVIDERS_REQUIRING_BASE_URL_AND_MODELS.has(provider)) return false;
  return true;
}

export function buildByokOnboardingTemplate(
  provider: string,
  options: { apiKeyCredential: string },
): ByokOnboardingTemplate {
  if (!isProviderEligibleForByokOnboarding(provider)) {
    // Defensive: callers should gate on `isProviderEligibleForByokOnboarding`
    // first and return a clean 400. Throwing here is the belt-and-suspenders
    // case for unit tests or future callers that forget the gate.
    throw new Error(
      `Provider "${provider}" is not eligible for BYOK onboarding`,
    );
  }

  const personalConnectionName = `${provider}-personal`;

  const personalConnection: PersonalConnectionTemplate = {
    name: personalConnectionName,
    provider,
    label: personalConnectionLabel(provider),
    auth: { type: "api_key", credential: options.apiKeyCredential },
    status: "active",
  };

  // All canonical managed connections get disabled on a fresh BYOK hatch.
  // There's no overlay-selected exemption today: the Docker hatch CLI no
  // longer ships a workspace-config overlay (that mechanism was removed in
  // PR #32025), so the "user selected a managed profile during onboarding"
  // path simply isn't reachable from this endpoint's caller. If it ever is,
  // we can take `excludeConnection` as an input and skip the matching row.
  const managedConnectionsToDisable: ManagedConnectionDisablePatch[] = Array.from(
    MANAGED_CONNECTION_NAMES,
  ).map((name) => ({
    name,
    auth: { type: "platform" },
    status: "disabled",
  }));

  // Symmetric to the connection-disable step: surface the managed profiles
  // the caller should stamp `status: "disabled"` on. The PUT route accepts
  // `{label?, status?}` for managed names and rejects everything else, so
  // the caller never has to know the rest of the managed-profile shape —
  // we just hand them the names.
  const managedProfilesToDisable = Array.from(MANAGED_PROFILE_NAMES);

  // Resolve each user profile template against the user's chosen provider
  // and the personal connection we just defined. The output is the exact
  // body the caller should PUT against `/v1/config/llm/profiles/:name`.
  const userProfiles: Record<string, ProfileEntry> = {};
  for (const [name, template] of Object.entries(USER_PROFILE_TEMPLATES)) {
    userProfiles[name] = materializeProfile(
      template,
      provider as NonNullable<ProfileEntry["provider"]>,
      personalConnectionName,
    );
  }

  const profileOrder = [
    ...Array.from(MANAGED_PROFILE_NAMES),
    ...Object.keys(USER_PROFILE_TEMPLATES),
  ];

  return {
    provider,
    personalConnection,
    managedConnectionsToDisable,
    managedProfilesToDisable,
    userProfiles,
    activeProfile: "custom-balanced",
    profileOrder,
  };
}
