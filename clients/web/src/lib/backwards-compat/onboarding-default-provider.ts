/**
 * Backwards-compat gate: onboarding's default-provider write path.
 *
 * Assistants at MIN_VERSION and above carry code-defined BYOK default
 * profiles: onboarding stores the key, creates the `<provider>-personal`
 * connection, and points `llm.defaultProvider` at the pick — the hatch's
 * `balanced` default then resolves through that provider's matrix column.
 * Older assistants can't complete that flow: pre-0.10.8 daemons 404
 * `PUT /v1/config/llm/default-provider`, and 0.10.8 through 0.11.0 accept
 * the write but resolve `balanced` through the vellum column regardless,
 * leaving the picked key unused. Both need the legacy flow instead
 * (author + activate a `custom-balanced` profile), which newer daemons
 * also understand — their BYOK conversion pass migrates it.
 *
 * MIN_VERSION targets 0.11.1: the next unreleased version after the
 * 0.11.0 cut, the first that can carry the code-defined BYOK defaults.
 *
 * Unlike the store-backed gates, onboarding applies the provider key to a
 * freshly hatched assistant before the identity store hydrates (the
 * connect + identity fetch happen afterwards), so this gate resolves the
 * daemon version straight from `/identity`. An unresolvable version gates
 * `false` — the legacy flow is the one every daemon understands.
 */
import { fetchAssistantIdentity } from "@/assistant/identity";
import { getImpersonatedAssistantVersion } from "./impersonate-version-flag";
import { versionSupports } from "./utils";

export const MIN_VERSION = "0.11.1";

export async function supportsOnboardingDefaultProvider(
  assistantId: string,
): Promise<boolean> {
  // The identity store applies impersonation in `setIdentity`; this gate
  // bypasses the store, so honor the dev flag directly.
  const impersonated = getImpersonatedAssistantVersion();
  if (impersonated !== null) {
    return versionSupports(impersonated, MIN_VERSION);
  }
  const identity = await fetchAssistantIdentity(assistantId);
  return versionSupports(identity?.version ?? null, MIN_VERSION);
}
