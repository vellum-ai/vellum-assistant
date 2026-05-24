/**
 * Request/response interceptors for the generated HeyAPI clients.
 *
 * Attaches three things to every outbound request:
 *   - `Vellum-Organization-Id` — selects the active org server-side.
 *   - `X-CSRFToken` (mutations only) — required by Django's
 *     SessionAuthentication.
 *   - `X-Vellum-Client-Id` + `X-Vellum-Interface-Id` — identify the
 *     originating tab/interface to the daemon. Required by ATL-703 self-echo
 *     suppression: the daemon echoes the client id back on the resulting
 *     `sync_changed` so the originator's SSE subscriber can be skipped.
 *
 * Import this module for its side effects in the app entrypoint
 * (`main.tsx`) so interceptors are installed before any API call fires.
 *
 * Reference: https://heyapi.dev/openapi-ts/clients/fetch#interceptors
 */
import { client as authClient } from "@/generated/auth/client.gen.js";
import { client as platformClient } from "@/generated/api/client.gen.js";
import { ensureCsrfCookie, getCsrfToken } from "@/lib/auth/csrf.js";
import { getClientRegistrationHeaders } from "@/lib/telemetry/client-identity.js";
import { getActiveOrganizationIdForRequests } from "@/stores/organization-store.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Exported for direct unit testing — production code paths invoke this
 * via the registrations at the bottom of the module. Keeping the function
 * named + exported lets tests assert the per-header contract without
 * reaching into the HeyAPI client's private interceptor list.
 */
export async function requestInterceptor(request: Request): Promise<Request> {
  const newRequest = new Request(request);
  const organizationId = getActiveOrganizationIdForRequests();

  if (organizationId) {
    newRequest.headers.set("Vellum-Organization-Id", organizationId);
  }

  // Per-tab client identity — sent on *every* request (GET included) so
  // SSE-via-fetch readers and short-lived mutations carry the same id. The
  // daemon uses this for self-echo suppression on `sync_changed` events.
  for (const [name, value] of Object.entries(getClientRegistrationHeaders())) {
    newRequest.headers.set(name, value);
  }

  if (MUTATING_METHODS.has(request.method)) {
    await ensureCsrfCookie();
    const csrfToken = getCsrfToken();
    if (csrfToken) {
      newRequest.headers.set("X-CSRFToken", csrfToken);
    }
  }

  return newRequest;
}

for (const apiClient of [authClient, platformClient]) {
  apiClient.interceptors.request.use(requestInterceptor);
}
