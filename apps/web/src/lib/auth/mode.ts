/**
 * SPA auth mode — a single build-time switch that determines whether
 * the app expects a sign-in flow.
 *
 * - `"cloud"` (default): the normal allauth-backed sign-in flow. Used
 *   for hosted deployments where a user identity is required.
 * - `"local"`: no sign-in. The SPA assumes it's pointed at a
 *   single-owner local daemon (typically the gateway running with
 *   `DISABLE_HTTP_AUTH=true`). The user owns the machine; that's the
 *   auth perimeter. The login screen is never rendered, and the auth
 *   store boots into an "always signed in as the local owner" state.
 *
 * Set at build time via `VITE_AUTH_MODE=local|cloud`. Unset → `"cloud"`.
 *
 * Why a build-time switch instead of runtime detection:
 *   1. Servers — not the SPA — enforce auth. The mode here only
 *      controls UI presence. Anyone can edit their build to claim
 *      `"local"`, but the daemon and gateway still gate on their own
 *      auth config. So the switch can't bypass real security.
 *   2. A self-hosted build, a cloud build, and a local-dev build are
 *      different deployable artifacts. The deployer knows which one
 *      they're producing; encoding that at build time avoids runtime
 *      mode-detection footguns.
 */

export type AuthMode = "local" | "cloud";

const RAW_MODE = (import.meta.env.VITE_AUTH_MODE ?? "").toLowerCase();

const AUTH_MODE: AuthMode = RAW_MODE === "local" ? "local" : "cloud";

export function getAuthMode(): AuthMode {
  return AUTH_MODE;
}

export function isLocalMode(): boolean {
  return AUTH_MODE === "local";
}
