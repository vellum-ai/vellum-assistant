/**
 * Shared resolver for the APNs environment a push token must be tagged with.
 *
 * APNs rejects a token minted under one entitlement environment when it is
 * dispatched against the other, so the platform stores the environment
 * alongside every token and the value must match the running build. Two token
 * upserts depend on that tag, and both resolve it here so they can never
 * disagree: device push tokens (`runtime/push-registration.ts`) and
 * ActivityKit Live Activity tokens
 * (`domains/chat/voice/live-voice/live-activity-push-registration.ts`). A
 * split resolution would let a TestFlight-signed dev build register device
 * tokens as production while its Live Activity updates get rejected as
 * sandbox-tagged.
 *
 * The primary source is the native `ApnsEnvironment` plugin
 * (`clients/ios/App/App/ApnsEnvironmentPlugin.swift`), which reads the real
 * `aps-environment` value from the embedded provisioning profile: TestFlight
 * and App Store builds always carry production APNs tokens regardless of
 * bundle id, which is exactly the case the bundle-suffix heuristic got wrong
 * for TestFlight dev builds. Shells predating the plugin, and profiles it
 * cannot parse, fall back to that heuristic.
 */

import { registerPlugin } from "@capacitor/core";

import type { ApnsEnvironmentEnum } from "@/generated/api/types.gen";

interface ApnsEnvironmentPlugin {
  get(): Promise<{ environment?: string }>;
}

/** Native entitlement-environment plugin; see the module docblock. */
const ApnsEnvironment =
  registerPlugin<ApnsEnvironmentPlugin>("ApnsEnvironment");

/** Suffix dev-signed builds ship (`App-Dev.xcconfig`); see module docblock. */
const DEV_BUNDLE_SUFFIX = ".dev";

/** Suffix-heuristic fallback for absent or `"unknown"` plugin results. */
function resolveApnsEnvironment(bundleId: string): ApnsEnvironmentEnum {
  return bundleId.endsWith(DEV_BUNDLE_SUFFIX) ? "development" : "production";
}

/**
 * Resolve the environment to tag a push token with, preferring the build's
 * real signing entitlement over the bundle-suffix heuristic.
 */
export async function resolveSignedApnsEnvironment(
  bundleId: string,
): Promise<ApnsEnvironmentEnum> {
  try {
    // Only the result crosses this `async` boundary, never the plugin Proxy
    // itself (see CAPACITOR.md).
    const { environment } = await ApnsEnvironment.get();
    if (environment === "development" || environment === "production") {
      return environment;
    }
    console.debug(
      "[apns-environment] unreadable APNs entitlement, using bundle-id heuristic:",
      environment,
    );
  } catch (err) {
    // `console.debug`, not `captureError`, per the `native-voice.ts` skew
    // convention: an older App Store/TestFlight shell without the plugin is
    // an expected state on every web deploy, not a fault.
    console.debug(
      "[apns-environment] ApnsEnvironment bridge unavailable, using bundle-id heuristic:",
      err,
    );
  }
  return resolveApnsEnvironment(bundleId);
}
