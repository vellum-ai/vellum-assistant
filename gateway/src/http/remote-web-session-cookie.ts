export const REMOTE_WEB_SESSION_COOKIE = "__Host-vellum_remote_web_session";

export function serializeRemoteWebSessionCookie(opts: {
  token: string;
  maxAgeSeconds: number;
}): string {
  return [
    `${REMOTE_WEB_SESSION_COOKIE}=${encodeURIComponent(opts.token)}`,
    "Path=/",
    `Max-Age=${Math.max(0, Math.floor(opts.maxAgeSeconds))}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
  ].join("; ");
}

export function extractRemoteWebSessionToken(req: Request): string | null {
  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(";")) {
    const [rawName, ...valueParts] = part.trim().split("=");
    if (rawName !== REMOTE_WEB_SESSION_COOKIE) continue;
    const rawValue = valueParts.join("=");
    if (!rawValue) return null;
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }

  return null;
}
