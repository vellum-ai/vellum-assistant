/**
 * Request/response interceptors for the generated HeyAPI clients.
 *
 * Attaches the `Vellum-Organization-Id` header and `X-CSRFToken` header
 * to all outbound requests. Import this module for its side effects in
 * the app entrypoint (`main.tsx`) so interceptors are installed before
 * any API call fires.
 *
 * Reference: https://heyapi.dev/openapi-ts/clients/fetch#interceptors
 */
import { client as authClient } from "@/generated/auth/client.gen.js";
import { client as platformClient } from "@/generated/api/client.gen.js";
import { ensureCsrfCookie, getCsrfToken } from "@/lib/auth/csrf.js";
import { getActiveOrganizationIdForRequests } from "@/domains/organization/organization-state.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function requestInterceptor(request: Request) {
  const newRequest = new Request(request);
  const organizationId = getActiveOrganizationIdForRequests();

  if (organizationId) {
    newRequest.headers.set("Vellum-Organization-Id", organizationId);
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
