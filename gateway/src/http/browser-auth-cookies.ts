export const BROWSER_REFRESH_COOKIE = "vellum_web_refresh";
const BROWSER_REFRESH_PATH = "/v1/guardian/refresh";

function normalizeCookiePath(value: string | undefined): string {
  if (!value || !value.startsWith("/") || /[;\r\n]/.test(value)) {
    return BROWSER_REFRESH_PATH;
  }
  return value;
}

export function remoteWebRefreshCookiePathForPublicBaseUrl(
  publicBaseUrl: string,
): string {
  const url = new URL(publicBaseUrl);
  const pathPrefix = url.pathname.replace(/\/+$/, "");
  return normalizeCookiePath(`${pathPrefix}${BROWSER_REFRESH_PATH}`);
}

function encodeCookieValue(value: string): string {
  return encodeURIComponent(value);
}

function browserAuthCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
  path: string | undefined,
): string {
  return [
    `${name}=${encodeCookieValue(value)}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Path=${normalizeCookiePath(path)}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ].join("; ");
}

export function buildRemoteWebBrowserAuthCookies(params: {
  refreshToken: string;
  refreshTokenExpiresAtMs: number;
  refreshCookiePath?: string;
}): string[] {
  const maxAgeSeconds = Math.ceil(
    (params.refreshTokenExpiresAtMs - Date.now()) / 1000,
  );
  return [
    browserAuthCookie(
      BROWSER_REFRESH_COOKIE,
      params.refreshToken,
      maxAgeSeconds,
      params.refreshCookiePath,
    ),
  ];
}

export function getRemoteWebRefreshCookie(req: Request): string {
  const header = req.headers.get("cookie");
  if (!header) return "";

  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName !== BROWSER_REFRESH_COOKIE) continue;
    const value = rawValue.join("=");
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return "";
}

export function hasRemoteWebRefreshCookie(req: Request): boolean {
  return Boolean(getRemoteWebRefreshCookie(req));
}
