import { hashToken } from "../../auth/guardian-bootstrap.js";
import {
  rotateCredentials,
  rotateBrowserCredentialsByRefreshToken,
  type RefreshErrorCode,
} from "../../auth/guardian-refresh.js";
import { getLogger } from "../../logger.js";
import {
  buildRemoteWebBrowserAuthCookies,
  getRemoteWebRefreshCookie,
} from "../browser-auth-cookies.js";

const log = getLogger("guardian-refresh-route");
const REQUIRED_BROWSER_REFRESH_FETCH_SITE = "same-origin";
const BROWSER_REFRESH_FORBIDDEN_RESPONSE = {
  error: {
    code: "FORBIDDEN",
    message: "Browser refresh requires a same-origin request",
  },
};

function refreshFailureResponse(error: RefreshErrorCode): Response {
  // 403 for tokens that are valid-but-forbidden (revoked, reused, or presented
  // from the wrong device); 401 for invalid/expired tokens and for
  // guardian_repair_required (the status clients treat as repairable).
  const forbidden: RefreshErrorCode[] = [
    "refresh_reuse_detected",
    "device_binding_mismatch",
    "revoked",
  ];
  const statusCode = forbidden.includes(error) ? 403 : 401;

  log.warn({ error }, "Refresh token rotation failed");
  return Response.json({ error }, { status: statusCode });
}

function browserRefreshResponse(
  result: Extract<
    ReturnType<typeof rotateBrowserCredentialsByRefreshToken>,
    { ok: true }
  >["result"],
): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const cookie of buildRemoteWebBrowserAuthCookies({
    refreshToken: result.refreshToken,
    refreshTokenExpiresAtMs: result.refreshTokenExpiresAt,
    refreshCookiePath: result.browserRefreshCookiePath,
  })) {
    headers.append("Set-Cookie", cookie);
  }

  return Response.json(
    {
      guardianPrincipalId: result.guardianPrincipalId,
      accessToken: result.accessToken,
      accessTokenExpiresAt: result.accessTokenExpiresAt,
      refreshAfter: result.refreshAfter,
    },
    { headers },
  );
}

function parseHttpUrl(value: string | null): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

function sameEffectiveOrigin(req: Request, url: URL): boolean {
  const target = new URL(req.url);
  if (url.host !== target.host) return false;
  if (url.protocol === target.protocol) return true;
  return target.protocol === "http:" && url.protocol === "https:";
}

function browserRefreshOriginFallbackAllows(req: Request): boolean {
  const origin = parseHttpUrl(req.headers.get("origin"));
  if (origin && sameEffectiveOrigin(req, origin)) return true;

  const referer = parseHttpUrl(req.headers.get("referer"));
  return !!referer && sameEffectiveOrigin(req, referer);
}

function browserRefreshFetchMetadataGuard(req: Request): Response | null {
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite) {
    if (fetchSite === REQUIRED_BROWSER_REFRESH_FETCH_SITE) return null;
    return Response.json(BROWSER_REFRESH_FORBIDDEN_RESPONSE, { status: 403 });
  }

  if (browserRefreshOriginFallbackAllows(req)) return null;

  return Response.json(BROWSER_REFRESH_FORBIDDEN_RESPONSE, { status: 403 });
}

export async function handleGuardianRefresh(req: Request): Promise<Response> {
  try {
    const browserRefreshToken = getRemoteWebRefreshCookie(req);
    if (browserRefreshToken) {
      const metadataError = browserRefreshFetchMetadataGuard(req);
      if (metadataError) return metadataError;

      const result = rotateBrowserCredentialsByRefreshToken({
        refreshToken: browserRefreshToken,
      });
      if (!result.ok) return refreshFailureResponse(result.error);

      log.info(
        {
          guardianPrincipalId: result.result.guardianPrincipalId,
        },
        "Browser refresh token rotation succeeded",
      );
      return browserRefreshResponse(result.result);
    }

    const body = (await req.json()) as Record<string, unknown>;
    const refreshToken =
      typeof body.refreshToken === "string" ? body.refreshToken : "";
    const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";

    if (!refreshToken) {
      return Response.json(
        {
          error: {
            code: "BAD_REQUEST",
            message: "Missing required field: refreshToken",
          },
        },
        { status: 400 },
      );
    }

    // The refresh token is bound to the device it was issued to. Require
    // legacy non-browser callers to prove the device so a leaked refresh token
    // cannot be redeemed from a different device.
    if (!deviceId) {
      return Response.json(
        {
          error: {
            code: "BAD_REQUEST",
            message: "Missing required field: deviceId",
          },
        },
        { status: 400 },
      );
    }

    const result = rotateCredentials({
      refreshToken,
      hashedDeviceId: hashToken(deviceId),
    });

    if (!result.ok) {
      return refreshFailureResponse(result.error);
    }

    log.info(
      {
        guardianPrincipalId: result.result.guardianPrincipalId,
      },
      "Refresh token rotation succeeded",
    );
    return Response.json(result.result);
  } catch (err) {
    log.error({ err }, "Guardian refresh failed");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
