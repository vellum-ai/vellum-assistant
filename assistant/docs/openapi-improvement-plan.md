# OpenAPI Schema Generator — Improvement Plan

## Context

PR [#21211](https://github.com/vellum-ai/vellum-assistant/pull/21211) merged a first-pass `generate-openapi.ts` script that statically analyzes route definition files via regex/brace-matching and outputs a minimal OpenAPI 3.0 YAML spec (217 paths, 259 operations). The goal is to eventually auto-generate a TypeScript client for `vellum-assistant-platform/web`.

This plan covers improvements to **the script itself**, **the HTTP server architecture**, and **the overall OpenAPI workflow**.

---

## A. Script Improvements

### A1. Replace regex-based extraction with programmatic route introspection

**Problem:** The script uses regex + balanced-brace scanning to extract `endpoint:` and `method:` from TypeScript source files. This is inherently fragile:

- Braces inside string literals or template expressions can confuse the scanner.
- Routes defined via computed values, variables, or spread patterns are silently missed.
- Inline routes in `buildRouteTable()` (e.g. `conversations`, `conversations/:id`, `browser-relay/*`, `internal/twilio/*`, `internal/oauth/callback`) are only caught because they happen to have string-literal `endpoint:` fields — but this isn't guaranteed.

**Recommendation:** Instead of statically analyzing source text, actually import and invoke the route definition functions at script-time. Since the script already runs in Bun, it can import each `*RouteDefinitions()` function, call it with stub deps, and extract the `endpoint`/`method` from the returned `RouteDefinition[]` arrays. This eliminates all regex fragility and automatically picks up new routes.

A lighter alternative: have each route module export a static metadata array alongside its `RouteDefinition[]`, or use a central route registry that both the runtime and the script read from.

### A2. Eliminate hardcoded `PRE_AUTH_ROUTES` and `NON_V1_ROUTES`

**Problem:** These lists are manually maintained and will silently drift from `routeRequest()` in `http-server.ts`. The `--check` mode can't catch this because both the script output and the committed YAML will be equally wrong.

**Recommendation:**

- For pre-auth routes: extract them from `routeRequest()` programmatically (see A1), or co-locate the pre-auth route metadata in a shared constant that both `routeRequest()` and the script import.
- For non-v1 routes (`/healthz`, `/readyz`, `/pages/{id}`): same approach — define these in a shared constant rather than duplicating them.
- As a stopgap: add a comment in `routeRequest()` near the pre-auth handling reminding developers to update `PRE_AUTH_ROUTES` in the generator, and add a lint check or test that counts routes.

### A3. Wire `--check` into CI

**Problem:** The `--check` flag exists but isn't in any CI job or pre-commit hook. The committed `openapi.yaml` can silently go stale.

**Recommendation:** Add `bun run generate:openapi -- --check` as a CI step (and optionally as a pre-commit hook). This is low-effort and high-value.

### A4. Improve `operationId` generation

**Problem:** The current slug derivation strips hyphens and special chars, producing sometimes-awkward IDs (e.g. `admin_rollbackmigrations_post`, `channelverificationsessions_status_get`, `braingraphui_get`). These will become function names in the generated TypeScript client.

**Recommendation:**

- Preserve hyphens as word boundaries and convert to camelCase (e.g. `adminRollbackMigrationsPost`, `channelVerificationSessionsStatusGet`).
- Or allow route definitions to specify an explicit `operationId` override for important endpoints, and only auto-generate as a fallback.
- Whichever approach, ensure the convention produces client method names that are natural to call (e.g. `listMessages`, `sendMessage`, `getConversation`).

### A5. Add request/response body schemas

**Problem:** Every operation currently has only a placeholder `200: Successful response` with no schema. This means the generated TypeScript client will have no type safety for request or response bodies — which largely defeats the purpose of codegen.

**Recommendation (phased):**

1. **Phase 1 — Response schemas:** Extract the `Response.json(...)` return types from handler functions. Many handlers return well-structured objects (e.g. `{ messages: [...] }`, `{ success: true, type, name }`, `{ status: "ok" }`). Use TypeScript's type system or JSDoc annotations on handlers to extract these.
2. **Phase 2 — Request body schemas:** Extract the `req.json() as { ... }` type assertions that already exist in most handlers. Many are already typed (e.g. `{ type?: string; name?: string; value?: string }` in secret-routes).
3. **Phase 3 — Shared schema components:** Deduplicate common shapes into `components/schemas` (e.g. `ConversationSummary`, `MessagePayload`, `SecretRequest`).

This is the highest-impact improvement for the end goal of a typed client.

### A6. Add error response schemas

**Problem:** No error responses are documented. The `httpError()` helper produces structured error responses with consistent shapes, but these aren't in the spec.

**Recommendation:** Add common error responses (400, 401, 403, 404, 422, 500) as shared components, referencing the `httpError` shape (`{ error: string, message: string }`). Apply them globally or per-operation.

### A7. Add authentication/security schemes

**Problem:** The spec has no `securitySchemes` or `security` definitions. The server uses JWT bearer auth, and some routes are pre-auth (unauthenticated).

**Recommendation:** Add a `BearerAuth` security scheme and apply it globally, with per-operation overrides for pre-auth routes (e.g. `security: []` for `/healthz`, `/readyz`, guardian bootstrap, pairing, audio).

### A8. Add query parameter definitions

**Problem:** Many GET endpoints accept query parameters (e.g. `?conversationId=...`, `?limit=50&offset=0`, `?conversationKey=...`) but none are documented in the spec.

**Recommendation:** Extract query parameter usage from handlers (most use `url.searchParams.get(...)`) and add them to the OpenAPI spec. This is critical for the TypeScript client to have proper function signatures.

### A9. Add tags for grouping

**Problem:** All 259 operations are in a flat list with no grouping.

**Recommendation:** Add OpenAPI `tags` based on the route module (e.g. `conversations`, `secrets`, `apps`, `channels`, `identity`). The module filename already provides a natural grouping key.

---

## B. HTTP Server Changes

### B1. Standardize handler signatures for schema extraction

**Problem:** Handler functions have inconsistent signatures. Some accept `(req: Request)`, some `(url: URL, ...)`, some use the `RouteContext` destructured. Request body types are cast inline with `as` rather than using validated schemas. This makes automated schema extraction difficult.

**Recommendation:**

- Adopt a consistent pattern where each handler declares its input/output types in a way that's extractable. For example, use Zod schemas or TypeScript interfaces for request bodies, and have handlers return typed response objects rather than raw `Response.json(...)`.
- This is a larger refactor but pays dividends: runtime validation, auto-generated OpenAPI schemas, and type-safe client code.

### B2. Consolidate inline routes from `buildRouteTable()` into route modules

**Problem:** Several routes are defined inline in `buildRouteTable()` in `http-server.ts` (~200 lines of inline handlers for conversations, browser-relay, twilio internal, oauth callback, etc.). These are harder for the script to discover and harder to maintain.

**Recommendation:** Extract these into their respective route modules. The inline comments already explain why they're inline (cross-cutting deps), but those deps can be passed via the existing dependency injection pattern used by other route modules.

### B3. Add route-level metadata to `RouteDefinition`

**Problem:** `RouteDefinition` currently has `endpoint`, `method`, `handler`, and optional `policyKey`. There's no place to attach OpenAPI metadata (description, tags, request/response schemas, query params).

**Recommendation:** Extend `RouteDefinition` with optional OpenAPI metadata fields:

```typescript
interface RouteDefinition {
  endpoint: string;
  method: string;
  handler: (ctx: RouteContext) => Promise<Response> | Response;
  policyKey?: string;
  // OpenAPI metadata
  summary?: string;
  description?: string;
  tags?: string[];
  requestBody?: SchemaDefinition;
  responseBody?: SchemaDefinition;
  queryParams?: ParamDefinition[];
}
```

This way, OpenAPI metadata lives next to the route definition and stays in sync naturally. The generator simply reads these fields instead of trying to reverse-engineer them from source code.

### B4. Move pre-auth route definitions into the declarative route system

**Problem:** Pre-auth routes (`/healthz`, `/readyz`, `/v1/audio/:id`, `/v1/pairing/*`, `/v1/guardian/*`) are handled via if-ladder in `routeRequest()` before the router runs. This means they bypass the declarative route table entirely.

**Recommendation:** Add a `preAuth: true` flag to `RouteDefinition` and have the router handle pre-auth dispatch. This way all routes — pre-auth and authenticated — live in one table, and the OpenAPI generator automatically picks them up. The `routeRequest()` method would just separate routes into pre-auth and post-auth sets.

---

## C. Workflow & Tooling

### C1. Set up TypeScript client codegen pipeline

**Problem:** The OpenAPI spec exists but there's no actual client generation step yet.

**Recommendation:** Evaluate and integrate a codegen tool:

- [`openapi-typescript`](https://github.com/openapi-ts/openapi-typescript) — generates TypeScript types from OpenAPI, pairs well with `openapi-fetch` for a lightweight typed client.
- [`orval`](https://orval.dev/) — generates React Query / fetch clients.
- [`openapi-generator`](https://openapi-generator.tech/) — heavier, but full client generation.

`openapi-typescript` + `openapi-fetch` is probably the best fit: lightweight, type-safe, and doesn't require runtime codegen.

### C2. Add a route count validation test

**Problem:** No automated check that the number of routes in the OpenAPI spec matches the actual routes registered by the server.

**Recommendation:** Add a test that instantiates the `HttpRouter` (or `RuntimeHttpServer`), counts the registered routes (including pre-auth), and compares against the OpenAPI spec. This catches silent route omissions even when `--check` passes.

### C3. Version the spec meaningfully

**Problem:** The `version` field is pulled from `package.json` at generation time and goes stale between regenerations.

**Recommendation:** Either auto-generate a hash-based version, or drop the version field entirely and rely on git for versioning. Alternatively, bump it as part of the `generate:openapi` script to always match the current package version at generation time (which it already does — but document that this is intentional and the check enforces it).

---

## Suggested Priority Order

| Priority | Item                                               | Effort | Impact    |
| -------- | -------------------------------------------------- | ------ | --------- |
| 1        | A3 — Wire `--check` into CI                        | Low    | High      |
| 2        | B3 — Add route-level metadata to `RouteDefinition` | Medium | High      |
| 3        | A5 — Add request/response body schemas             | High   | Very High |
| 4        | A2 — Eliminate hardcoded route lists               | Medium | Medium    |
| 5        | B4 — Move pre-auth routes into declarative system  | Medium | Medium    |
| 6        | A4 — Improve `operationId` generation              | Low    | Medium    |
| 7        | A8 — Add query parameter definitions               | Medium | High      |
| 8        | A9 — Add tags for grouping                         | Low    | Low       |
| 9        | A7 — Add auth/security schemes                     | Low    | Medium    |
| 10       | A6 — Add error response schemas                    | Low    | Medium    |
| 11       | A1 — Replace regex with programmatic extraction    | Medium | High      |
| 12       | B1 — Standardize handler signatures                | High   | High      |
| 13       | B2 — Consolidate inline routes                     | Low    | Low       |
| 14       | C1 — Set up client codegen pipeline                | Medium | Very High |
| 15       | C2 — Route count validation test                   | Low    | Medium    |
| 16       | C3 — Version the spec meaningfully                 | Low    | Low       |

Items 1-3 are the critical path to a useful typed client. Item 14 (C1) can start in parallel once A5 has minimal coverage.
