/**
 * Shared route metadata constants — single source of truth.
 *
 * These define routes that aren't discovered automatically from route modules
 * by the OpenAPI generator (`scripts/generate-openapi.ts`):
 *
 *   - **Pre-auth routes**: bypass JWT authentication in `routeRequest()`
 *   - **Non-v1 routes**: live outside the `/v1/` URL namespace
 *
 * `generate-openapi.ts` imports from here; `http-server.ts` references it.
 * When adding or removing pre-auth or non-v1 routes in `routeRequest()`,
 * update this file and regenerate the OpenAPI spec:
 *
 *     cd assistant && bun run generate:openapi
 */

// ---------------------------------------------------------------------------
// Pre-auth routes (/v1/* but before JWT check)
// ---------------------------------------------------------------------------

/**
 * Routes under `/v1/` that bypass JWT authentication.
 *
 * These are dispatched in `routeRequest()` **before** the auth middleware.
 * The `endpoint` format uses `:param` syntax, matching the `RouteDefinition`
 * convention used elsewhere in the codebase.
 *
 * **Important:** If you add a new pre-auth route to `routeRequest()` in
 * `http-server.ts`, you must add a corresponding entry here so the OpenAPI
 * spec stays in sync. The CI `--check` job will fail if the spec is stale.
 */
export const PRE_AUTH_V1_ROUTES: ReadonlyArray<{
  readonly method: string;
  readonly endpoint: string;
}> = [
  { method: "GET", endpoint: "audio/:id" },
  { method: "POST", endpoint: "guardian/init" },
  { method: "POST", endpoint: "guardian/refresh" },
  { method: "POST", endpoint: "pairing/request" },
  { method: "GET", endpoint: "pairing/status" },
];

// ---------------------------------------------------------------------------
// Non-v1 routes (outside the /v1/ namespace)
// ---------------------------------------------------------------------------

/**
 * Top-level routes that live outside the `/v1/` namespace.
 *
 * `path` uses OpenAPI `{param}` syntax for direct embedding in the spec.
 *
 * **Important:** If you add a new non-v1 route to `routeRequest()` in
 * `http-server.ts`, you must add a corresponding entry here.
 */
export const NON_V1_ROUTES: ReadonlyArray<{
  readonly method: string;
  readonly path: string;
}> = [
  { method: "GET", path: "/healthz" },
  { method: "GET", path: "/readyz" },
  { method: "GET", path: "/pages/{id}" },
];
