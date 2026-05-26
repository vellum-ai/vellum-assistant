/**
 * Apply the BYOK onboarding recipe to a freshly hatched assistant.
 *
 * Workflow:
 *   1. GET  /v1/inference/onboarding-templates/:provider — fetch the recipe
 *   2. POST /v1/inference/provider-connections          — create `${provider}-personal`
 *   3. PATCH /v1/inference/provider-connections/:name    — disable each managed connection
 *   4. PUT   /v1/config/llm/profiles/:name              — disable each managed profile
 *   5. PUT   /v1/config/llm/profiles/:name              — write each custom user profile
 *   6. POST  /v1/config/set                              — llm.activeProfile = custom-balanced
 *   7. POST  /v1/config/set                              — llm.profileOrder  = [...]
 *
 * This module replaces the Docker-hatch workspace-config overlay that PR
 * #32025 removed. The CLI now drives BYOK setup the same way any external
 * client would: via the assistant's public HTTP API. The endpoint added in
 * the matching server commit hands out the *recipe*; this orchestration
 * applies it.
 *
 * Idempotency: each step tolerates the "already exists" / "already this
 * value" case so that re-running the helper after a partial setup converges
 * without raising. The hatch wrapper in `docker.ts` swallows the eventual
 * Error and prints a "run `vellum setup ...`" recovery hint so a failure
 * doesn't tear down the whole hatch.
 */

import {
  gatewayUrlWithPath,
  type LlmProviderId,
  parseErrorMessage,
  type ProviderSecretFetch,
  secretHeaders,
} from "./provider-secrets.js";

/**
 * Shape of the server recipe. Mirrors `ByokOnboardingTemplate` in
 * `assistant/src/config/byok-onboarding-templates.ts`. Kept as a structural
 * type here (rather than imported across the assistant/cli boundary) so this
 * module stays self-contained — the runtime check `assertRecipeShape` below
 * guards the boundary.
 */
type OnboardingRecipe = {
  provider: string;
  personalConnection: {
    name: string;
    provider: string;
    label: string;
    auth: { type: "api_key"; credential: string };
    status: "active";
  };
  managedConnectionsToDisable: Array<{
    name: string;
    auth: { type: "platform" };
    status: "disabled";
  }>;
  managedProfilesToDisable: string[];
  userProfiles: Record<string, Record<string, unknown>>;
  activeProfile: string;
  profileOrder: string[];
};

export type ApplyByokOnboardingOptions = {
  gatewayUrl: string;
  provider: LlmProviderId;
  /**
   * Guardian bearer token. Optional to mirror `HatchProviderApiKeyOptions` —
   * the same hatch flow that may not lease a token also can't apply BYOK
   * profiles, but the call sites share a single typed seam.
   */
  bearerToken?: string;
  fetchImpl?: ProviderSecretFetch;
  log?: (message: string) => void;
};

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Apply the BYOK onboarding recipe. Throws on any unrecoverable failure;
 * caller is responsible for catching and turning that into a user-facing
 * recovery hint (see `docker.ts`).
 */
export async function applyByokOnboarding(
  options: ApplyByokOnboardingOptions,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => {});

  const recipe = await fetchRecipe(options, fetchImpl);

  await createPersonalConnection(options, fetchImpl, recipe);

  for (const patch of recipe.managedConnectionsToDisable) {
    await disableManagedConnection(options, fetchImpl, patch);
  }

  for (const name of recipe.managedProfilesToDisable) {
    await disableManagedProfile(options, fetchImpl, name);
  }

  for (const [name, profile] of Object.entries(recipe.userProfiles)) {
    await writeUserProfile(options, fetchImpl, name, profile);
  }

  await setConfigPath(
    options,
    fetchImpl,
    "llm.activeProfile",
    recipe.activeProfile,
  );
  await setConfigPath(
    options,
    fetchImpl,
    "llm.profileOrder",
    recipe.profileOrder,
  );

  log(`Configured BYOK inference profiles for ${recipe.provider}.`);
}

async function fetchRecipe(
  options: ApplyByokOnboardingOptions,
  fetchImpl: ProviderSecretFetch,
): Promise<OnboardingRecipe> {
  const url = gatewayUrlWithPath(
    options.gatewayUrl,
    `/v1/inference/onboarding-templates/${encodeURIComponent(options.provider)}`,
  );
  const response = await fetchImpl(url, {
    method: "GET",
    headers: secretHeaders(options.bearerToken),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const message = await parseErrorMessage(response);
    throw new Error(
      `Failed to fetch BYOK onboarding templates for ${options.provider}: ${message}`,
    );
  }
  const body = (await response.json()) as unknown;
  assertRecipeShape(body);
  return body;
}

async function createPersonalConnection(
  options: ApplyByokOnboardingOptions,
  fetchImpl: ProviderSecretFetch,
  recipe: OnboardingRecipe,
): Promise<void> {
  const response = await fetchImpl(
    gatewayUrlWithPath(options.gatewayUrl, "/v1/inference/provider-connections"),
    {
      method: "POST",
      headers: secretHeaders(options.bearerToken),
      body: JSON.stringify(recipe.personalConnection),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  // 409 = the personal connection already exists from a previous setup
  // attempt; treat as success since the row already encodes the right shape
  // (auth ref → CES). Anything else is fatal.
  if (response.status === 409) return;
  if (!response.ok) {
    const message = await parseErrorMessage(response);
    throw new Error(
      `Failed to create personal provider connection: ${message}`,
    );
  }
}

async function disableManagedConnection(
  options: ApplyByokOnboardingOptions,
  fetchImpl: ProviderSecretFetch,
  patch: OnboardingRecipe["managedConnectionsToDisable"][number],
): Promise<void> {
  const response = await fetchImpl(
    gatewayUrlWithPath(
      options.gatewayUrl,
      `/v1/inference/provider-connections/${encodeURIComponent(patch.name)}`,
    ),
    {
      method: "PATCH",
      headers: secretHeaders(options.bearerToken),
      body: JSON.stringify({ auth: patch.auth, status: patch.status }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  // 404 happens when a managed connection isn't seeded in this workspace
  // (e.g. catalog dropped a provider). Idempotent disable: nothing to do.
  if (response.status === 404) return;
  if (!response.ok) {
    const message = await parseErrorMessage(response);
    throw new Error(
      `Failed to disable managed connection "${patch.name}": ${message}`,
    );
  }
}

async function disableManagedProfile(
  options: ApplyByokOnboardingOptions,
  fetchImpl: ProviderSecretFetch,
  name: string,
): Promise<void> {
  const response = await fetchImpl(
    gatewayUrlWithPath(
      options.gatewayUrl,
      `/v1/config/llm/profiles/${encodeURIComponent(name)}`,
    ),
    {
      method: "PUT",
      headers: secretHeaders(options.bearerToken),
      body: JSON.stringify({ status: "disabled" }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    const message = await parseErrorMessage(response);
    throw new Error(
      `Failed to disable managed profile "${name}": ${message}`,
    );
  }
}

async function writeUserProfile(
  options: ApplyByokOnboardingOptions,
  fetchImpl: ProviderSecretFetch,
  name: string,
  profile: Record<string, unknown>,
): Promise<void> {
  const response = await fetchImpl(
    gatewayUrlWithPath(
      options.gatewayUrl,
      `/v1/config/llm/profiles/${encodeURIComponent(name)}`,
    ),
    {
      method: "PUT",
      headers: secretHeaders(options.bearerToken),
      body: JSON.stringify(profile),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    const message = await parseErrorMessage(response);
    throw new Error(
      `Failed to write user profile "${name}": ${message}`,
    );
  }
}

async function setConfigPath(
  options: ApplyByokOnboardingOptions,
  fetchImpl: ProviderSecretFetch,
  path: string,
  value: unknown,
): Promise<void> {
  const response = await fetchImpl(
    gatewayUrlWithPath(options.gatewayUrl, "/v1/config/set"),
    {
      method: "POST",
      headers: secretHeaders(options.bearerToken),
      body: JSON.stringify({ path, value }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    const message = await parseErrorMessage(response);
    throw new Error(`Failed to set ${path}: ${message}`);
  }
}

function assertRecipeShape(body: unknown): asserts body is OnboardingRecipe {
  if (!body || typeof body !== "object") {
    throw new Error("BYOK onboarding response was not a JSON object");
  }
  const r = body as Record<string, unknown>;
  const required = [
    "provider",
    "personalConnection",
    "managedConnectionsToDisable",
    "managedProfilesToDisable",
    "userProfiles",
    "activeProfile",
    "profileOrder",
  ];
  for (const key of required) {
    if (!(key in r)) {
      throw new Error(
        `BYOK onboarding response is missing required field "${key}"`,
      );
    }
  }
}
