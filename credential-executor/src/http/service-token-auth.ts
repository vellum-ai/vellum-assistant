/**
 * Bearer-token authentication shared by the CES HTTP routes.
 *
 * Both the CES and its callers hold the same `CES_SERVICE_TOKEN` via the
 * environment; every credential-bearing route authenticates with it.
 */

import { timingSafeEqual } from "node:crypto";

/**
 * Validate the Authorization header against the configured service token.
 * Returns an error Response if auth fails, or null if auth succeeds.
 */
export function checkServiceTokenAuth(
  req: Request,
  serviceToken: string,
): Response | null {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return new Response(
      JSON.stringify({ error: "Missing Authorization header" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0]!.toLowerCase() !== "bearer") {
    return new Response(
      JSON.stringify({
        error: "Invalid Authorization header format. Expected: Bearer <token>",
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  const provided = Buffer.from(parts[1]!);
  const expected = Buffer.from(serviceToken);
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return new Response(JSON.stringify({ error: "Invalid service token" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  return null;
}
