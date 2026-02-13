import { timingSafeEqual } from "crypto";

export type BearerAuthResult =
  | { authorized: true }
  | { authorized: false; reason: string };

export function validateBearerToken(
  authorizationHeader: string | null,
  expectedToken: string,
): BearerAuthResult {
  if (!authorizationHeader) {
    return { authorized: false, reason: "Missing Authorization header" };
  }

  if (!authorizationHeader.slice(0, 7).toLowerCase().startsWith("bearer ")) {
    return { authorized: false, reason: "Invalid authorization scheme" };
  }

  const token = authorizationHeader.slice(7);
  if (!token) {
    return { authorized: false, reason: "Empty bearer token" };
  }

  const a = Buffer.from(token);
  const b = Buffer.from(expectedToken);
  if (a.length !== b.length) {
    return { authorized: false, reason: "Invalid bearer token" };
  }
  if (!timingSafeEqual(a, b)) {
    return { authorized: false, reason: "Invalid bearer token" };
  }

  return { authorized: true };
}
