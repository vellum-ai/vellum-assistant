/**
 * Credential CRUD HTTP endpoints for the CES managed service.
 *
 * Exposes credential management over HTTP so the assistant and gateway
 * can access credentials via the network instead of reading keys.enc
 * directly from a shared volume.
 *
 * Endpoints:
 * - `GET  /v1/credentials`           — list credential account names
 * - `POST /v1/credentials/bulk`      — bulk set credentials
 * - `GET  /v1/credentials/:account`  — get a credential value
 * - `POST /v1/credentials/:account`  — set a credential value
 * - `DELETE /v1/credentials/:account` — delete a credential
 *
 * Auth: All endpoints require a `CES_SERVICE_TOKEN` bearer token in the
 * `Authorization` header. Both the CES and its callers share this token
 * via the environment.
 */

import { timingSafeEqual } from "node:crypto";

import type { SecureKeyBackend } from "@vellumai/credential-storage";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Validate the Authorization header against the configured service token.
 * Returns an error Response if auth fails, or null if auth succeeds.
 */
function checkAuth(req: Request, serviceToken: string): Response | null {
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
      JSON.stringify({ error: "Invalid Authorization header format. Expected: Bearer <token>" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  const provided = Buffer.from(parts[1]!);
  const expected = Buffer.from(serviceToken);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return new Response(
      JSON.stringify({ error: "Invalid service token" }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export interface CredentialRouteDeps {
  /** The secure key backend to wrap. */
  backend: SecureKeyBackend;
  /** Service token for authenticating requests. */
  serviceToken: string;
}

const CREDENTIAL_PATH_PREFIX = "/v1/credentials";

/**
 * Try to handle a credential CRUD request. Returns a Response if the
 * request matches a credential route, or null if it doesn't match
 * (allowing the caller to fall through to other routes).
 */
export async function handleCredentialRoute(
  req: Request,
  deps: CredentialRouteDeps,
): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;

  // Only handle /v1/credentials paths
  if (!pathname.startsWith(CREDENTIAL_PATH_PREFIX)) {
    return null;
  }

  // Auth check
  const authError = checkAuth(req, deps.serviceToken);
  if (authError) return authError;

  const { backend } = deps;

  // Extract account from path: /v1/credentials/:account
  const accountSegment = pathname.slice(CREDENTIAL_PATH_PREFIX.length);

  // POST /v1/credentials/bulk — bulk set credentials
  // Only intercept POST; other methods (GET, DELETE) fall through to the
  // :account handler so a credential literally named "bulk" stays accessible.
  if (accountSegment === "/bulk" && req.method === "POST") {
    let body: { credentials?: unknown };
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    if (!Array.isArray(body.credentials)) {
      return new Response(
        JSON.stringify({ error: "Body must contain a 'credentials' array field" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    for (const entry of body.credentials) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof entry.account !== "string" ||
        typeof entry.value !== "string"
      ) {
        return new Response(
          JSON.stringify({
            error: "Each credential entry must have string 'account' and 'value' fields",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    const results: Array<{ account: string; ok: boolean }> = [];
    for (const entry of body.credentials as Array<{ account: string; value: string }>) {
      const ok = await backend.set(entry.account, entry.value);
      results.push({ account: entry.account, ok: !!ok });
    }

    return new Response(
      JSON.stringify({ results }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  // GET /v1/credentials — list all credential account names
  if (accountSegment === "" || accountSegment === "/") {
    if (req.method !== "GET") {
      return new Response(
        JSON.stringify({ error: "Method not allowed" }),
        { status: 405, headers: { "Content-Type": "application/json" } },
      );
    }

    const accounts = await backend.list();
    return new Response(
      JSON.stringify({ accounts }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  // Remaining routes require /:account
  if (!accountSegment.startsWith("/")) {
    return null; // Not a credential route
  }

  const account = decodeURIComponent(accountSegment.slice(1));
  if (!account) {
    return new Response(
      JSON.stringify({ error: "Account name is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  switch (req.method) {
    // GET /v1/credentials/:account — get credential value
    case "GET": {
      const value = await backend.get(account);
      if (value === undefined) {
        return new Response(
          JSON.stringify({ error: "Credential not found", account }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ account, value }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // POST /v1/credentials/:account — set credential value
    case "POST": {
      let body: { value?: string };
      try {
        body = await req.json();
      } catch {
        return new Response(
          JSON.stringify({ error: "Invalid JSON body" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      if (typeof body.value !== "string") {
        return new Response(
          JSON.stringify({ error: "Body must contain a 'value' string field" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      const ok = await backend.set(account, body.value);
      if (!ok) {
        return new Response(
          JSON.stringify({ error: "Failed to set credential", account }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ ok: true, account }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // DELETE /v1/credentials/:account — delete credential
    case "DELETE": {
      const result = await backend.delete(account);
      if (result === "not-found") {
        return new Response(
          JSON.stringify({ error: "Credential not found", account }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }
      if (result === "error") {
        return new Response(
          JSON.stringify({ error: "Failed to delete credential", account }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ ok: true, account }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    default:
      return new Response(
        JSON.stringify({ error: "Method not allowed" }),
        { status: 405, headers: { "Content-Type": "application/json" } },
      );
  }
}
