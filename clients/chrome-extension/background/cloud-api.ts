/**
 * Centralized HTTP client for vellum-cloud platform API calls.
 *
 * All authenticated requests to the platform (Django) go through
 * `cloudApiFetch()`, which automatically includes:
 *   - `credentials: 'include'` (session cookie)
 *   - `Vellum-Organization-Id` header (from the stored CloudSession)
 *   - `X-CSRFToken` header on mutating methods (from the Django csrftoken cookie)
 *   - `Accept: application/json`
 *
 * This mirrors the web client's request interceptor pattern and
 * the desktop app's `defaultHeaders` on the migration transport.
 */

import { getStoredSession } from "./cloud-auth.js";
import type { ExtensionEnvironment } from "./extension-environment.js";
import { cloudUrlsForEnvironment } from "./extension-environment.js";

// ── CSRF helpers ────────────────────────────────────────────────────

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Read the Django `csrftoken` cookie for the given API base URL.
 *
 * Requires the `cookies` permission in the manifest. Returns `null`
 * when the cookie is missing (e.g. before the first authenticated GET
 * that sets it).
 */
export async function getCsrfToken(apiBaseUrl: string): Promise<string | null> {
  try {
    const cookie = await chrome.cookies.get({
      name: "csrftoken",
      url: apiBaseUrl,
    });
    return cookie?.value ?? null;
  } catch {
    return null;
  }
}

// ── Fetch helper ────────────────────────────────────────────────────

/**
 * Make an authenticated fetch to the platform API. Resolves the base
 * URL from the given environment and injects standard headers.
 *
 * The `organizationId` is read from the stored CloudSession. Callers
 * can override it or supply additional headers via `init.headers`.
 */
export async function cloudApiFetch(
  environment: ExtensionEnvironment,
  path: string,
  init?: RequestInit & { skipOrgHeader?: boolean },
): Promise<Response> {
  const { apiBaseUrl } = cloudUrlsForEnvironment(environment);

  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  // Inject org header from the stored session unless explicitly skipped.
  // The /v1/organizations/ endpoint must skip this (bootstrap call).
  if (!init?.skipOrgHeader) {
    const session = await getStoredSession();
    if (session?.organizationId) {
      headers["Vellum-Organization-Id"] = session.organizationId;
    }
  }

  // Include the CSRF token on mutating requests. Django's
  // CsrfViewMiddleware checks the X-CSRFToken header against the
  // csrftoken cookie for session-authenticated POST/PUT/PATCH/DELETE.
  const method = (init?.method ?? "GET").toUpperCase();
  if (MUTATING_METHODS.has(method)) {
    const csrfToken = await getCsrfToken(apiBaseUrl);
    if (csrfToken) {
      headers["X-CSRFToken"] = csrfToken;
    }
  }

  // Merge caller-supplied headers (they win over defaults).
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => {
        headers[k] = v;
      });
    } else if (Array.isArray(init.headers)) {
      for (const [k, v] of init.headers) {
        headers[k] = v;
      }
    } else {
      Object.assign(headers, init.headers);
    }
  }

  const { skipOrgHeader: _, ...restInit } = init ?? {};
  return fetch(`${apiBaseUrl}${path}`, {
    ...restInit,
    credentials: "include",
    headers,
  });
}

// ── Convenience helpers ─────────────────────────────────────────────

export interface CloudAssistant {
  id: string;
  name: string;
}

/**
 * Fetch the user's organizations and return the first org ID.
 * This is a bootstrap call — no org header needed.
 */
export async function fetchOrganizationId(
  environment: ExtensionEnvironment,
): Promise<string | null> {
  try {
    const response = await cloudApiFetch(environment, "/v1/organizations/", {
      skipOrgHeader: true,
    });
    if (!response.ok) return null;

    const data = (await response.json()) as {
      results?: Array<{ id: string }>;
    };
    if (Array.isArray(data.results) && data.results.length > 0) {
      return data.results[0]!.id;
    }
  } catch {
    // Non-fatal: assistants fetch will fail with a clear error.
  }
  return null;
}

/**
 * Fetch the current user's assistants from the platform API.
 */
export async function fetchAssistants(
  environment: ExtensionEnvironment,
): Promise<CloudAssistant[]> {
  const response = await cloudApiFetch(environment, "/v1/assistants/");

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Failed to fetch assistants (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    results?: Array<{ id: string; name: string }>;
  };

  if (!Array.isArray(data.results)) {
    return [];
  }

  return data.results.map((a) => ({
    id: a.id,
    name: a.name || "Unnamed Assistant",
  }));
}
