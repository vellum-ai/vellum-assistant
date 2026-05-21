/**
 * Shared header builders for raw `fetch()` calls against the
 * Django-proxied daemon routes (`/v1/assistants/{id}/...`).
 *
 * Prefer the generated HeyAPI client (`@/generated/api/client.gen.js`)
 * when possible — its request interceptor at
 * `@/lib/api-interceptors.ts` already adds these headers automatically.
 * These helpers exist only for the cases that genuinely need raw `fetch`
 * (streaming SSE, blob downloads with manual progress, etc.).
 *
 * Anything that handles `Vellum-Organization-Id` or `X-CSRFToken` outside
 * `lib/auth/` and `lib/api-interceptors.ts` should be routed through here.
 * Drift between sites is the failure mode that caused
 * [LUM-1784](https://linear.app/vellum/issue/LUM-1784): a request that
 * skips the header is silently rejected by Django's
 * `MissingVellumOrganizationIDHeaderError`, the wrapper returns null,
 * and the UI degrades to a fallback instead of surfacing the error.
 */
import { ensureCsrfCookie, getCsrfToken } from "@/lib/auth/csrf.js";
import { getActiveOrganizationIdForRequests } from "@/stores/organization-store.js";

/**
 * Headers for a safe (GET/HEAD) request against an assistant-scoped
 * daemon route. Adds `Vellum-Organization-Id` when an active
 * organization is set.
 */
export function buildVellumHeaders(
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  const organizationId = getActiveOrganizationIdForRequests();
  if (organizationId) {
    headers["Vellum-Organization-Id"] = organizationId;
  }
  return headers;
}

/**
 * Headers for a mutating (POST/PUT/PATCH/DELETE) request. Adds the org
 * header and, after bootstrapping the CSRF cookie, the `X-CSRFToken`
 * header that Django's `SessionAuthentication` requires.
 */
export async function buildVellumMutatingHeaders(
  extra?: Record<string, string>,
): Promise<Record<string, string>> {
  const headers = buildVellumHeaders(extra);
  await ensureCsrfCookie();
  const csrfToken = getCsrfToken();
  if (csrfToken) {
    headers["X-CSRFToken"] = csrfToken;
  }
  return headers;
}
