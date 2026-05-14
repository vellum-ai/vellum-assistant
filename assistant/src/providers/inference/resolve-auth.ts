/**
 * Resolves an `Auth` config into a `ResolvedAuth` that adapters consume.
 *
 * Resolution rules:
 *   - api_key  → fetch credential from vault → inject as bearer header
 *   - platform → build managed proxy URL and fetch the platform API key
 *   - none     → pass through with no auth headers
 *   - oauth_subscription / service_account → reject (v2 not yet shipped)
 */

import {
  buildManagedBaseUrl,
  resolveManagedProxyContext,
} from "../../providers/platform-proxy/context.js";
import { getSecureKeyAsync } from "../../security/secure-keys.js";
import type { Auth, ResolvedAuth } from "./auth.js";

export type ResolveAuthError =
  | { code: "credential_not_found"; credential: string }
  | { code: "platform_unavailable" }
  | { code: "not_implemented"; authType: string };

export async function resolveAuth(
  auth: Auth,
  provider: string,
): Promise<
  { ok: true; resolved: ResolvedAuth } | { ok: false; error: ResolveAuthError }
> {
  switch (auth.type) {
    case "api_key": {
      const value = await getSecureKeyAsync(auth.credential);
      if (!value) {
        return {
          ok: false,
          error: { code: "credential_not_found", credential: auth.credential },
        };
      }
      return {
        ok: true,
        resolved: {
          kind: "header",
          headers: { Authorization: `Bearer ${value}` },
        },
      };
    }

    case "platform": {
      const managedBaseUrl = await buildManagedBaseUrl(provider);
      if (!managedBaseUrl) {
        return { ok: false, error: { code: "platform_unavailable" } };
      }
      const ctx = await resolveManagedProxyContext();
      return {
        ok: true,
        resolved: {
          kind: "header",
          headers: { Authorization: `Bearer ${ctx.assistantApiKey}` },
          baseUrl: managedBaseUrl,
        },
      };
    }

    case "none":
      return { ok: true, resolved: { kind: "none" } };

    case "oauth_subscription":
    case "service_account":
      return {
        ok: false,
        error: { code: "not_implemented", authType: auth.type },
      };
  }
}
