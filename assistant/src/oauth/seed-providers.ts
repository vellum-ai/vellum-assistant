import { seedProviders } from "./oauth-store.js";
import { PROVIDER_BASE_URLS } from "./provider-base-urls.js";
import { PROVIDER_PROFILES } from "./provider-profiles.js";

/**
 * Seed the oauth_providers table with well-known provider configurations
 * from PROVIDER_PROFILES. Uses INSERT OR IGNORE so existing rows are never
 * overwritten — safe to call on every startup.
 */
export function seedOAuthProviders(): void {
  const profiles = Object.values(PROVIDER_PROFILES).map((profile) => ({
    providerKey: profile.service,
    authUrl: profile.authUrl,
    tokenUrl: profile.tokenUrl,
    tokenEndpointAuthMethod: profile.tokenEndpointAuthMethod,
    userinfoUrl: profile.userinfoUrl,
    baseUrl: PROVIDER_BASE_URLS[profile.service],
    defaultScopes: profile.defaultScopes,
    scopePolicy: { ...profile.scopePolicy },
    extraParams: profile.extraParams,
    callbackTransport: profile.callbackTransport,
    loopbackPort: profile.loopbackPort,
  }));

  seedProviders(profiles);
}
