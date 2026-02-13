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

  if (!authorizationHeader.startsWith("Bearer ")) {
    return { authorized: false, reason: "Invalid authorization scheme" };
  }

  const token = authorizationHeader.slice("Bearer ".length);

  if (token !== expectedToken) {
    return { authorized: false, reason: "Invalid bearer token" };
  }

  return { authorized: true };
}
