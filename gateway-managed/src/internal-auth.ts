import type {
  ManagedGatewayBearerTokenMetadata,
  ManagedGatewayConfig,
} from "./config.js";

const DEFAULT_REQUIRED_SCOPE = "managed-gateway:internal";

export type ManagedGatewayInternalPrincipal = {
  principalId: string;
  authMode: "bearer" | "mtls";
  audience: string;
  scopes: string[];
};

export class ManagedGatewayInternalAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type ManagedGatewayHandler = (
  request: Request,
  principal: ManagedGatewayInternalPrincipal,
) => Response | Promise<Response>;

export function withInternalAuth(
  config: ManagedGatewayConfig,
  handler: ManagedGatewayHandler,
  requiredScope: string = DEFAULT_REQUIRED_SCOPE,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    try {
      const principal = authenticateInternalRequest(request, config, requiredScope);
      return await handler(request, principal);
    } catch (error) {
      if (error instanceof ManagedGatewayInternalAuthError) {
        return Response.json(
          {
            error: {
              code: error.code,
              detail: error.message,
            },
          },
          { status: error.status },
        );
      }

      throw error;
    }
  };
}

export function authenticateInternalRequest(
  request: Request,
  config: ManagedGatewayConfig,
  requiredScope: string = DEFAULT_REQUIRED_SCOPE,
): ManagedGatewayInternalPrincipal {
  if (config.internalAuth.mode === "bearer") {
    return authenticateBearer(request, config, requiredScope);
  }

  return authenticateMtls(request, config, requiredScope);
}

function authenticateBearer(
  request: Request,
  config: ManagedGatewayConfig,
  requiredScope: string,
): ManagedGatewayInternalPrincipal {
  const authorization = request.headers.get("authorization")?.trim() || "";
  if (!authorization.startsWith("Bearer ")) {
    throw new ManagedGatewayInternalAuthError(
      "missing_bearer",
      401,
      "Missing managed gateway bearer token.",
    );
  }

  const tokenValue = authorization.slice("Bearer ".length).trim();
  if (!tokenValue) {
    throw new ManagedGatewayInternalAuthError(
      "missing_bearer",
      401,
      "Missing managed gateway bearer token.",
    );
  }

  const metadata = Object.hasOwn(config.internalAuth.bearerTokens, tokenValue)
    ? config.internalAuth.bearerTokens[tokenValue]
    : undefined;
  if (!metadata) {
    throw new ManagedGatewayInternalAuthError(
      "unknown_bearer",
      401,
      "Unknown managed gateway bearer token.",
    );
  }

  ensureBearerTokenIsActive(metadata, config);
  ensureAudience(metadata.audience, config.internalAuth.audience, "bearer");
  ensureScope(metadata.scopes, requiredScope, "bearer");

  return {
    principalId: metadata.principal,
    authMode: "bearer",
    audience: metadata.audience,
    scopes: metadata.scopes,
  };
}

function authenticateMtls(
  request: Request,
  config: ManagedGatewayConfig,
  requiredScope: string,
): ManagedGatewayInternalPrincipal {
  const principalHeader = config.internalAuth.mtlsPrincipalHeader;
  const principalId = request.headers.get(principalHeader)?.trim() || "";
  if (!principalId) {
    throw new ManagedGatewayInternalAuthError(
      "missing_mtls_principal",
      401,
      "Missing managed gateway mTLS principal.",
    );
  }

  if (!config.internalAuth.mtlsPrincipals.has(principalId)) {
    throw new ManagedGatewayInternalAuthError(
      "unauthorized_mtls_principal",
      401,
      "Managed gateway mTLS principal is not authorized.",
    );
  }

  const audienceHeader = config.internalAuth.mtlsAudienceHeader;
  const audience = request.headers.get(audienceHeader)?.trim() || "";
  if (!audience) {
    throw new ManagedGatewayInternalAuthError(
      "missing_mtls_audience",
      401,
      "Missing managed gateway mTLS audience.",
    );
  }
  ensureAudience(audience, config.internalAuth.audience, "mTLS");

  const scopesHeader = config.internalAuth.mtlsScopesHeader;
  const scopes = (request.headers.get(scopesHeader) || "")
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);

  ensureScope(scopes, requiredScope, "mTLS");

  return {
    principalId,
    authMode: "mtls",
    audience,
    scopes,
  };
}

function ensureBearerTokenIsActive(
  metadata: ManagedGatewayBearerTokenMetadata,
  config: ManagedGatewayConfig,
): void {
  if (metadata.revoked || config.internalAuth.revokedTokenIds.has(metadata.tokenId)) {
    throw new ManagedGatewayInternalAuthError(
      "revoked_bearer",
      401,
      "Managed gateway bearer token has been revoked.",
    );
  }

  if (!metadata.expiresAt) {
    return;
  }

  const expiresAt = Date.parse(metadata.expiresAt);
  if (Number.isNaN(expiresAt)) {
    throw new ManagedGatewayInternalAuthError(
      "invalid_bearer_expiry",
      401,
      "Managed gateway bearer token expiry metadata is invalid.",
    );
  }

  if (Date.now() >= expiresAt) {
    throw new ManagedGatewayInternalAuthError(
      "expired_bearer",
      401,
      "Managed gateway bearer token is expired.",
    );
  }
}

function ensureAudience(
  actualAudience: string,
  expectedAudience: string,
  authKind: "bearer" | "mTLS",
): void {
  if (actualAudience === expectedAudience) {
    return;
  }

  throw new ManagedGatewayInternalAuthError(
    "audience_mismatch",
    401,
    `Managed gateway ${authKind} audience mismatch.`,
  );
}

function ensureScope(
  scopes: string[],
  requiredScope: string,
  authKind: "bearer" | "mTLS",
): void {
  if (scopes.includes(requiredScope)) {
    return;
  }

  throw new ManagedGatewayInternalAuthError(
    "missing_scope",
    401,
    `Managed gateway ${authKind} credentials are missing required scope ${requiredScope}.`,
  );
}
