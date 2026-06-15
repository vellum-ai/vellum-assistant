import { extractRemoteWebSessionToken } from "./remote-web-session-cookie.js";

export function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  return authHeader.slice(7);
}

export function hasAuthorizationHeader(req: Request): boolean {
  return Boolean(req.headers.get("authorization")?.trim());
}

export function extractEdgeToken(req: Request): string | null {
  const bearer = extractBearerToken(req);
  if (bearer) return bearer;
  if (hasAuthorizationHeader(req)) return null;
  return extractRemoteWebSessionToken(req);
}
