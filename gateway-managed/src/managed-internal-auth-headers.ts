import type { ManagedGatewayConfig } from "./config.js";

export function buildManagedInternalAuthHeaders(
  config: ManagedGatewayConfig,
  requiredScope: string,
): Headers | null {
  if (config.internalAuth.mode === "bearer") {
    const tokenValue = selectActiveInternalBearerToken(config, requiredScope);
    if (!tokenValue) {
      return null;
    }

    return new Headers({
      authorization: `Bearer ${tokenValue}`,
    });
  }

  const principal = config.internalAuth.mtlsPrincipals.values().next().value as
    | string
    | undefined;
  if (!principal) {
    return null;
  }

  return new Headers({
    [config.internalAuth.mtlsPrincipalHeader]: principal,
    [config.internalAuth.mtlsAudienceHeader]: config.internalAuth.audience,
    [config.internalAuth.mtlsScopesHeader]: requiredScope,
  });
}

function selectActiveInternalBearerToken(
  config: ManagedGatewayConfig,
  requiredScope: string,
  nowMs: number = Date.now(),
): string | null {
  for (const [tokenValue, metadata] of Object.entries(config.internalAuth.bearerTokens)) {
    if (metadata.revoked || config.internalAuth.revokedTokenIds.has(metadata.tokenId)) {
      continue;
    }

    if (metadata.expiresAt) {
      const expiresAt = Date.parse(metadata.expiresAt);
      if (Number.isNaN(expiresAt) || expiresAt <= nowMs) {
        continue;
      }
    }

    if (
      metadata.audience !== config.internalAuth.audience
      || !metadata.scopes.includes(requiredScope)
    ) {
      continue;
    }

    return tokenValue;
  }

  return null;
}
