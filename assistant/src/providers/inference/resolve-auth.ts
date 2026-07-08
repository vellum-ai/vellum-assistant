/**
 * Resolves an `Auth` config into a `ResolvedAuth` that adapters consume.
 *
 * Resolution rules:
 *   - api_key              → fetch credential from vault → inject as bearer header
 *   - platform             → build managed proxy URL and fetch the platform API key
 *   - none                 → pass through with no auth headers
 *   - oauth_subscription   → fetch OAuth token from vault (with auto-refresh) → inject as bearer header
 *   - service_account      → reject (v2 not yet shipped)
 */

import { getSecureKeyAsync } from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";
import {
  buildManagedBaseUrl,
  resolveManagedProxyContext,
} from "../platform-proxy/context.js";
import {
  type Auth,
  PROVIDERS_REQUIRING_BASE_URL_AND_MODELS,
  type ResolvedAuth,
} from "./auth.js";

const log = getLogger("resolve-auth");

export type ResolveAuthError =
  | { code: "credential_not_found"; credential: string }
  | { code: "platform_unavailable" }
  | { code: "not_implemented"; authType: string };

export async function resolveAuth(
  auth: Auth,
  provider: string,
  opts: { baseUrl?: string | null } = {},
): Promise<
  { ok: true; resolved: ResolvedAuth } | { ok: false; error: ResolveAuthError }
> {
  // Defense-in-depth: strip baseUrl for providers that should not accept one.
  // The route layer rejects base_url for non-openai-compatible providers, but
  // this guard catches any code path that bypasses route validation (e.g.
  // corrupted DB rows, direct calls from internal code).
  let safeBaseUrl = opts.baseUrl;
  if (safeBaseUrl && !PROVIDERS_REQUIRING_BASE_URL_AND_MODELS.has(provider)) {
    log.warn(
      { provider, baseUrl: safeBaseUrl },
      `Stripping baseUrl for provider "${provider}" — base_url is only valid for openai-compatible providers.`,
    );
    safeBaseUrl = null;
  }

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
          ...(safeBaseUrl ? { baseUrl: safeBaseUrl } : {}),
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

    case "oauth_subscription": {
      // Extract the credential prefix from the credential key.
      // The credential field stores "credential/openai-codex/access_token";
      // we need the prefix "credential/openai-codex" for the refresh logic.
      const credentialPrefix = auth.credential.replace(/\/access_token$/, "");

      const { getValidCodexAccessToken } =
        await import("./codex-token-refresh.js");
      const token = await getValidCodexAccessToken(credentialPrefix);

      if (!token) {
        return {
          ok: false,
          error: { code: "credential_not_found", credential: auth.credential },
        };
      }
      return {
        ok: true,
        resolved: {
          kind: "header",
          headers: { Authorization: `Bearer ${token}` },
        },
      };
    }

    case "service_account":
      return {
        ok: false,
        error: { code: "not_implemented", authType: auth.type },
      };
  }
}
