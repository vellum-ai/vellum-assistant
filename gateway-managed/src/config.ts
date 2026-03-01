export type ManagedGatewayInternalAuthMode = "bearer" | "mtls";

export type ManagedGatewayBearerTokenMetadata = {
  tokenId: string;
  principal: string;
  audience: string;
  scopes: string[];
  expiresAt: string | null;
  revoked: boolean;
};

export type ManagedGatewayInternalAuthConfig = {
  mode: ManagedGatewayInternalAuthMode;
  audience: string;
  bearerTokens: Record<string, ManagedGatewayBearerTokenMetadata>;
  revokedTokenIds: Set<string>;
  mtlsPrincipals: Set<string>;
  mtlsPrincipalHeader: string;
  mtlsAudienceHeader: string;
  mtlsScopesHeader: string;
};

export type ManagedGatewayTwilioAuthTokenMetadata = {
  tokenId: string;
  authToken: string;
  expiresAt: string | null;
  revoked: boolean;
};

export type ManagedGatewayTwilioConfig = {
  authTokens: Record<string, ManagedGatewayTwilioAuthTokenMetadata>;
  revokedTokenIds: Set<string>;
};

export type ManagedGatewayConfig = {
  port: number;
  enabled: boolean;
  serviceName: string;
  mode: string;
  strictStartupValidation: boolean;
  djangoInternalBaseUrl: string | null;
  internalAuth: ManagedGatewayInternalAuthConfig;
  twilio: ManagedGatewayTwilioConfig;
};

function parseBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error("Boolean env values must be true/false.");
}

function parseCsv(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );
}

function parseScopes(raw: unknown): string[] {
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0);
  }

  if (Array.isArray(raw)) {
    return raw
      .map((scope) => (typeof scope === "string" ? scope.trim() : ""))
      .filter((scope) => scope.length > 0);
  }

  throw new Error("Bearer token scopes must be a string or string array.");
}

function parseExpiry(raw: unknown, subject: string): string | null {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }

  if (typeof raw !== "string") {
    throw new Error(`${subject} expires_at must be a string.`);
  }

  const parsedEpoch = Date.parse(raw);
  if (Number.isNaN(parsedEpoch)) {
    throw new Error(`${subject} expires_at must be an ISO-8601 datetime.`);
  }

  return raw;
}

function parseBearerTokens(
  rawValue: string | undefined,
  defaultAudience: string,
): Record<string, ManagedGatewayBearerTokenMetadata> {
  const source = rawValue?.trim() || "{}";

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("MANAGED_GATEWAY_INTERNAL_BEARER_TOKENS must be valid JSON.");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      "MANAGED_GATEWAY_INTERNAL_BEARER_TOKENS must be a JSON object keyed by token value.",
    );
  }

  const result: Record<string, ManagedGatewayBearerTokenMetadata> = {};

  for (const [tokenValue, rawMetadata] of Object.entries(parsed)) {
    if (typeof rawMetadata !== "object" || rawMetadata === null || Array.isArray(rawMetadata)) {
      throw new Error("Each managed-gateway bearer token entry must be an object.");
    }

    const metadata = rawMetadata as Record<string, unknown>;

    const tokenIdRaw = metadata.token_id ?? metadata.tokenId ?? tokenValue;
    if (typeof tokenIdRaw !== "string" || tokenIdRaw.trim().length === 0) {
      throw new Error("Each managed-gateway bearer token must define token_id.");
    }

    const principalRaw = metadata.principal ?? "managed-gateway";
    if (typeof principalRaw !== "string" || principalRaw.trim().length === 0) {
      throw new Error("Each managed-gateway bearer token must define principal.");
    }

    const audienceRaw = metadata.audience ?? defaultAudience;
    if (typeof audienceRaw !== "string" || audienceRaw.trim().length === 0) {
      throw new Error("Each managed-gateway bearer token must define audience.");
    }

    const scopesRaw = metadata.scopes ?? ["managed-gateway:internal"];
    const scopes = parseScopes(scopesRaw);
    if (scopes.length === 0) {
      throw new Error("Each managed-gateway bearer token must define at least one scope.");
    }

    const revokedRaw = metadata.revoked;
    if (revokedRaw !== undefined && typeof revokedRaw !== "boolean") {
      throw new Error("Each managed-gateway bearer token revoked value must be boolean.");
    }

    result[tokenValue] = {
      tokenId: tokenIdRaw.trim(),
      principal: principalRaw.trim(),
      audience: audienceRaw.trim(),
      scopes,
      expiresAt: parseExpiry(metadata.expires_at ?? metadata.expiresAt, "Bearer token"),
      revoked: revokedRaw === true,
    };
  }

  return result;
}

function parseTwilioAuthTokens(
  rawValue: string | undefined,
): Record<string, ManagedGatewayTwilioAuthTokenMetadata> {
  const source = rawValue?.trim() || "{}";

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("MANAGED_GATEWAY_TWILIO_AUTH_TOKENS must be valid JSON.");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      "MANAGED_GATEWAY_TWILIO_AUTH_TOKENS must be a JSON object keyed by token label.",
    );
  }

  const result: Record<string, ManagedGatewayTwilioAuthTokenMetadata> = {};

  for (const [tokenLabel, rawMetadata] of Object.entries(parsed)) {
    if (typeof rawMetadata !== "object" || rawMetadata === null || Array.isArray(rawMetadata)) {
      throw new Error("Each managed-gateway Twilio token entry must be an object.");
    }

    const metadata = rawMetadata as Record<string, unknown>;

    const tokenIdRaw = metadata.token_id ?? metadata.tokenId ?? tokenLabel;
    if (typeof tokenIdRaw !== "string" || tokenIdRaw.trim().length === 0) {
      throw new Error("Each managed-gateway Twilio token must define token_id.");
    }

    const authTokenRaw = metadata.auth_token ?? metadata.authToken;
    if (typeof authTokenRaw !== "string" || authTokenRaw.trim().length === 0) {
      throw new Error("Each managed-gateway Twilio token must define auth_token.");
    }

    const revokedRaw = metadata.revoked;
    if (revokedRaw !== undefined && typeof revokedRaw !== "boolean") {
      throw new Error("Each managed-gateway Twilio token revoked value must be boolean.");
    }

    result[tokenLabel] = {
      tokenId: tokenIdRaw.trim(),
      authToken: authTokenRaw.trim(),
      expiresAt: parseExpiry(metadata.expires_at ?? metadata.expiresAt, "Twilio token"),
      revoked: revokedRaw === true,
    };
  }

  return result;
}

function hasActiveTwilioAuthToken(
  twilioConfig: ManagedGatewayTwilioConfig,
  nowMs: number = Date.now(),
): boolean {
  for (const token of Object.values(twilioConfig.authTokens)) {
    if (token.revoked || twilioConfig.revokedTokenIds.has(token.tokenId)) {
      continue;
    }

    if (token.expiresAt) {
      const expiresAt = Date.parse(token.expiresAt);
      if (Number.isNaN(expiresAt) || expiresAt <= nowMs) {
        continue;
      }
    }

    return true;
  }

  return false;
}

function parseInternalAuthMode(raw: string | undefined): ManagedGatewayInternalAuthMode {
  const normalized = (raw || "bearer").trim().toLowerCase();
  if (normalized === "bearer" || normalized === "mtls") {
    return normalized;
  }

  throw new Error(
    "MANAGED_GATEWAY_INTERNAL_AUTH_MODE must be one of: bearer, mtls.",
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ManagedGatewayConfig {
  const rawPort = env.MANAGED_GATEWAY_PORT || "7831";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("MANAGED_GATEWAY_PORT must be a valid port number.");
  }

  const strictStartupValidation = parseBoolean(
    env.MANAGED_GATEWAY_STRICT_STARTUP_VALIDATION,
    true,
  );

  const djangoInternalBaseUrlRaw = env.MANAGED_GATEWAY_DJANGO_INTERNAL_BASE_URL;
  const djangoInternalBaseUrl = djangoInternalBaseUrlRaw?.trim() || null;

  const enabled = parseBoolean(env.MANAGED_GATEWAY_ENABLED, true);

  const authAudience =
    env.MANAGED_GATEWAY_INTERNAL_AUTH_AUDIENCE || "managed-gateway-internal";
  const internalAuth: ManagedGatewayInternalAuthConfig = {
    mode: parseInternalAuthMode(env.MANAGED_GATEWAY_INTERNAL_AUTH_MODE),
    audience: authAudience,
    bearerTokens: parseBearerTokens(
      env.MANAGED_GATEWAY_INTERNAL_BEARER_TOKENS,
      authAudience,
    ),
    revokedTokenIds: parseCsv(env.MANAGED_GATEWAY_INTERNAL_REVOKED_TOKEN_IDS),
    mtlsPrincipals: parseCsv(env.MANAGED_GATEWAY_INTERNAL_MTLS_PRINCIPALS),
    mtlsPrincipalHeader:
      env.MANAGED_GATEWAY_MTLS_PRINCIPAL_HEADER ||
      "x-managed-gateway-principal",
    mtlsAudienceHeader:
      env.MANAGED_GATEWAY_MTLS_AUDIENCE_HEADER || "x-managed-gateway-audience",
    mtlsScopesHeader:
      env.MANAGED_GATEWAY_MTLS_SCOPES_HEADER || "x-managed-gateway-scopes",
  };
  const twilio: ManagedGatewayTwilioConfig = {
    authTokens: parseTwilioAuthTokens(env.MANAGED_GATEWAY_TWILIO_AUTH_TOKENS),
    revokedTokenIds: parseCsv(env.MANAGED_GATEWAY_TWILIO_REVOKED_TOKEN_IDS),
  };

  if (strictStartupValidation && enabled) {
    if (!djangoInternalBaseUrl) {
      throw new Error(
        "MANAGED_GATEWAY_DJANGO_INTERNAL_BASE_URL is required when MANAGED_GATEWAY_ENABLED=true.",
      );
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(djangoInternalBaseUrl);
    } catch {
      throw new Error(
        "MANAGED_GATEWAY_DJANGO_INTERNAL_BASE_URL must be a valid absolute URL.",
      );
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error(
        "MANAGED_GATEWAY_DJANGO_INTERNAL_BASE_URL must use http or https.",
      );
    }

    if (
      internalAuth.mode === "bearer"
      && Object.keys(internalAuth.bearerTokens).length === 0
    ) {
      throw new Error(
        "MANAGED_GATEWAY_INTERNAL_BEARER_TOKENS must define at least one token when bearer mode is enabled.",
      );
    }

    if (internalAuth.mode === "mtls" && internalAuth.mtlsPrincipals.size === 0) {
      throw new Error(
        "MANAGED_GATEWAY_INTERNAL_MTLS_PRINCIPALS must define at least one principal when mTLS mode is enabled.",
      );
    }

    if (!hasActiveTwilioAuthToken(twilio)) {
      throw new Error(
        "MANAGED_GATEWAY_TWILIO_AUTH_TOKENS must define at least one active token when managed gateway is enabled.",
      );
    }
  }

  return {
    port,
    enabled,
    serviceName: env.MANAGED_GATEWAY_SERVICE_NAME || "managed-gateway",
    mode: env.MANAGED_GATEWAY_MODE || "skeleton",
    strictStartupValidation,
    djangoInternalBaseUrl,
    internalAuth,
    twilio,
  };
}
