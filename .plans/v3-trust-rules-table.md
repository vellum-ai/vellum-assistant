# V3 Trust Rules: SQLite Table, Seeding, HTTP CRUD, and Classifier Integration

## Overview
Phase 2 of the V3 Trust Rules project. Adds a persistent SQLite `trust_rules` table seeded from the existing `DEFAULT_COMMAND_REGISTRY`, exposes HTTP CRUD endpoints for the macOS client (behind `permission-controls-v3` feature flag), and refactors the gateway classifiers to read base risk from the table instead of the in-code registry. User-modified and soft-deleted rules survive gateway restarts. The registry upsert on startup respects three guards (origin=default, user_modified=0, deleted=0) so user customizations are never overwritten.

**Naming convention:** The v3 trust rules table is named `trust_rules` in SQLite. The HTTP routes live at `/v1/trust-rules-v3/` to avoid collision with the existing v1 trust rule endpoints at `/v1/trust-rules`. Once v1 is deprecated, the v3 routes can be aliased to the shorter path.

**API path:** `/v1/trust-rules-v3` (not `/v1/trust-rules`, which is already in use for the allow/deny trust rule CRUD).

## PR 1: Add trust_rules Drizzle table schema
### Depends on
None

### Branch
v3-trust-rules/pr-1-drizzle-schema

### Title
feat(gateway): add trust_rules Drizzle table schema

### Files
- gateway/src/db/schema.ts

### Implementation steps
1. In `gateway/src/db/schema.ts`, add a new table definition after the `conversationThresholdOverrides` table:
   ```typescript
   export const trustRules = sqliteTable(
     "trust_rules",
     {
       id: text("id").primaryKey(),
       tool: text("tool").notNull(),
       pattern: text("pattern").notNull(),
       risk: text("risk").notNull(), // "low" | "medium" | "high"
       description: text("description").notNull(),
       origin: text("origin").notNull(), // "default" | "user_defined"
       userModified: integer("user_modified", { mode: "boolean" }).notNull().default(false),
       deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
       createdAt: text("created_at").notNull(),
       updatedAt: text("updated_at").notNull(),
     },
     (table) => [
       index("idx_trust_rules_tool_pattern").on(table.tool, table.pattern),
     ],
   );
   ```
   Use a unique index on `(tool, pattern)` via Drizzle's `uniqueIndex` helper:
   ```typescript
   import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
   ```
   Replace the regular `index` with `uniqueIndex("idx_trust_rules_tool_pattern")`.

2. Import `uniqueIndex` from `drizzle-orm/sqlite-core` (it should already have `index` imported — add `uniqueIndex` to the existing import).

### Acceptance criteria
- `trustRules` table exported from `schema.ts`
- Table has all 10 columns: id, tool, pattern, risk, description, origin, user_modified, deleted, created_at, updated_at
- `(tool, pattern)` has a unique index
- `user_modified` and `deleted` use integer boolean mode
- `initGatewayDb()` auto-pushes the new table on next startup (no migration files needed)

## PR 2: Create TrustRuleV3Store with CRUD operations
### Depends on
PR 1

### Branch
v3-trust-rules/pr-2-trust-rule-v3-store

### Title
feat(gateway): add TrustRuleV3Store with SQLite CRUD operations

### Files
- gateway/src/db/trust-rule-v3-store.ts
- gateway/src/__tests__/trust-rule-v3-store.test.ts

### Implementation steps
1. Create `gateway/src/db/trust-rule-v3-store.ts` with a `TrustRuleV3Store` class following the existing store pattern (see `gateway/src/db/contact-store.ts`):
   - Constructor accepts optional `GatewayDb` for test injection, otherwise uses `getGatewayDb()`.
   - Define a `TrustRuleV3` TypeScript interface matching the response shape:
     ```typescript
     export interface TrustRuleV3 {
       id: string;
       tool: string;
       pattern: string;
       risk: "low" | "medium" | "high";
       description: string;
       origin: "default" | "user_defined";
       userModified: boolean;
       deleted: boolean;
       createdAt: string;
       updatedAt: string;
     }
     ```
   - `list(filters?: { origin?: string; tool?: string; includeDeleted?: boolean })`: Returns `TrustRuleV3[]`. By default excludes soft-deleted rules. When `origin` is provided, filters by origin. When `tool` is provided, filters by tool. When `includeDeleted` is true, includes soft-deleted.
   - `getById(id: string)`: Returns `TrustRuleV3 | null`.
   - `create(input: { tool: string; pattern: string; risk: string; description: string })`: Creates a user-defined rule. Sets `origin="user_defined"`, `userModified=false`, `deleted=false`. Generates a UUIDv4 `id`. Sets `createdAt` and `updatedAt` to current ISO 8601 UTC. Returns the created `TrustRuleV3`.
   - `update(id: string, updates: { risk?: string; description?: string })`: Updates an existing rule. If the rule has `origin="default"`, sets `userModified=true`. Updates `updatedAt`. Returns the updated `TrustRuleV3`. Throws if not found.
   - `remove(id: string)`: For `origin="user_defined"` rules, hard-deletes (DELETE FROM). For `origin="default"` rules, soft-deletes (sets `deleted=true`, updates `updatedAt`). Returns `boolean` (true if found). Throws if not found.
   - `reset(id: string)`: Only for `origin="default"` rules. Clears `userModified` (set to false), clears `deleted` (set to false), updates `updatedAt`. Does NOT restore the original risk from the registry (the caller must provide the original risk). Instead, accepts `originalRisk` parameter and sets `risk` to that value. Returns the reset `TrustRuleV3`. Throws if not found or if origin is not "default".
   - `upsertDefault(input: { id: string; tool: string; pattern: string; risk: string; description: string })`: Inserts a default rule. On conflict `(tool, pattern)`, updates risk and description ONLY IF `origin='default' AND user_modified=0 AND deleted=0`. This implements the three-guard upsert. Uses raw SQL via `db.run(sql\`...\`)` for the conditional ON CONFLICT clause.
   - `listActive(tool?: string)`: Returns all active (non-deleted) rules, optionally filtered by tool. This is the query the cache will use.

2. Create `gateway/src/__tests__/trust-rule-v3-store.test.ts`:
   - Use the existing test pattern: `beforeEach` calls `resetGatewayDb()` then `initGatewayDb()`, `afterEach` calls `resetGatewayDb()`.
   - Test `create()`: creates a user-defined rule, verify all fields including auto-generated id, createdAt, updatedAt.
   - Test `list()` with filters: origin, tool, includeDeleted.
   - Test `getById()`: found and not found.
   - Test `update()`: verify userModified set to true for default rules.
   - Test `remove()`: verify hard-delete for user_defined, soft-delete for default.
   - Test `reset()`: verify clears userModified and deleted, restores risk.
   - Test `upsertDefault()`: verify insert, verify update respects three guards.
   - Test three-guard upsert: insert default, modify it (`userModified=true`), re-upsert — verify the modified rule is NOT overwritten. Test with `deleted=true` — verify not overwritten. Test with `origin='user_defined'` — verify not overwritten.
   - Test `listActive()`: returns non-deleted rules only.

### Acceptance criteria
- `TrustRuleV3Store` class exported with all CRUD methods
- `TrustRuleV3` interface matches the specified response shape
- Deterministic IDs for defaults (format: `default:<tool>:<pattern-slug>`)
- UUIDv4 IDs for user-defined rules
- Three-guard upsert respects `origin=default AND user_modified=0 AND deleted=0`
- Soft-delete for defaults, hard-delete for user-defined
- All tests pass

## PR 3: Seed trust_rules from DEFAULT_COMMAND_REGISTRY
### Depends on
PR 2

### Branch
v3-trust-rules/pr-3-seed-from-registry

### Title
feat(gateway): seed trust_rules table from DEFAULT_COMMAND_REGISTRY on startup

### Files
- gateway/src/db/seed-trust-rules-v3.ts
- gateway/src/__tests__/seed-trust-rules-v3.test.ts
- gateway/src/db/connection.ts

### Implementation steps
1. Create `gateway/src/db/seed-trust-rules-v3.ts`:
   - Import `DEFAULT_COMMAND_REGISTRY` from `../risk/command-registry.js` and `TrustRuleV3Store` from `./trust-rule-v3-store.js`.
   - Export `seedTrustRuleV3sFromRegistry(store: TrustRuleV3Store)`.
   - Walk the registry and produce one row per top-level command and one row per subcommand (recursively). For each entry:
     - `tool`: `"bash"` (the registry entries apply to bash/host_bash tools)
     - `pattern`: For top-level: the command name (e.g., `"ls"`, `"git"`). For subcommands: `"<parent> <sub>"` (e.g., `"git push"`, `"git stash drop"`).
     - `risk`: The `baseRisk` from the `CommandRiskSpec`.
     - `description`: Use `spec.reason` if present, otherwise generate from the command name (e.g., `"ls (default)"`, `"git push"`, `"sudo — Elevates to superuser privileges"`).
     - `id`: Deterministic format `default:bash:<command-slug>` where `<command-slug>` is the pattern with spaces replaced by hyphens (e.g., `default:bash:git-push`).
   - Call `store.upsertDefault()` for each entry. The three-guard upsert ensures user modifications are preserved.
   - Return the count of rows upserted for logging.

2. In `gateway/src/db/connection.ts`, after `runDataMigrations(getRawDb(db))` in `initGatewayDb()`:
   - Import `seedTrustRuleV3sFromRegistry` and `TrustRuleV3Store`.
   - After data migrations, call:
     ```typescript
     const trustRuleV3Store = new TrustRuleV3Store(db);
     await seedTrustRuleV3sFromRegistry(trustRuleV3Store);
     ```
   - Note: `seedTrustRuleV3sFromRegistry` is synchronous (Drizzle operations are sync with bun:sqlite), but keep async signature for future-proofing.

3. Create `gateway/src/__tests__/seed-trust-rules-v3.test.ts`:
   - Test that seeding creates rows for all registry entries (top-level + subcommands).
   - Test that re-seeding (calling seed twice) is idempotent — same number of active rules.
   - Test three-guard protection: modify a rule's risk, re-seed, verify the modified rule is NOT overwritten.
   - Test three-guard with deleted: soft-delete a rule, re-seed, verify NOT restored.
   - Test that deterministic IDs are consistent across re-seeds.
   - Test that the count returned is reasonable (check it's > 200 for the current registry size).

### Acceptance criteria
- `seedTrustRuleV3sFromRegistry()` transforms the full DEFAULT_COMMAND_REGISTRY into trust_rules rows
- Each top-level command and each subcommand gets its own row
- Deterministic IDs follow `default:bash:<slug>` format
- Three-guard upsert protects user modifications on re-seed
- Seeding is wired into `initGatewayDb()` so it runs on every startup
- Re-seeding is idempotent for unmodified rules

## PR 4: In-memory risk rule cache with invalidation
### Depends on
PR 2

### Branch
v3-trust-rules/pr-4-trust-rule-v3-cache

### Title
feat(gateway): add in-memory risk rule cache with invalidation

### Files
- gateway/src/risk/trust-rule-v3-cache.ts
- gateway/src/__tests__/trust-rule-v3-cache.test.ts

### Implementation steps
1. Create `gateway/src/risk/trust-rule-v3-cache.ts`:
   - Import `TrustRuleV3Store` and `TrustRuleV3` from `../db/trust-rule-v3-store.js`.
   - Export a singleton pattern:
     ```typescript
     let cache: TrustRuleV3Cache | null = null;

     export function initTrustRuleV3Cache(store?: TrustRuleV3Store): void {
       cache = new TrustRuleV3Cache(store ?? new TrustRuleV3Store());
     }

     export function getTrustRuleV3Cache(): TrustRuleV3Cache {
       if (!cache) throw new Error("Risk rule cache not initialized — call initTrustRuleV3Cache() at startup");
       return cache;
     }

     export function invalidateTrustRuleV3Cache(): void {
       cache?.refresh();
     }

     export function resetTrustRuleV3Cache(): void {
       cache = null;
     }
     ```
   - `TrustRuleV3Cache` class:
     - Constructor takes `TrustRuleV3Store`.
     - On construction, calls `refresh()` to load initial data.
     - Internal data structure: `Map<string, Map<string, TrustRuleV3>>` keyed by `tool` then `pattern`.
     - `refresh()`: Clears the maps, calls `store.listActive()`, rebuilds the maps.
     - `findBaseRisk(tool: string, command: string): TrustRuleV3 | null`: Looks up by exact match on `(tool, command)`. Returns the matching `TrustRuleV3` or null. For bash tools, also tries stripping path prefixes (e.g., `/usr/bin/rm` → `rm`) and resolving subcommand patterns (e.g., for command `git push`, tries `"git push"` then `"git"`).
     - `findToolOverride(tool: string, pattern: string): TrustRuleV3 | null`: For non-bash classifiers. Looks up by `(tool, pattern)` exact match. Used for file/web/skill/schedule user overrides.
     - `getAllForTool(tool: string): TrustRuleV3[]`: Returns all active rules for a given tool.

2. Create `gateway/src/__tests__/trust-rule-v3-cache.test.ts`:
   - Test `findBaseRisk()`: exact match, path-stripped match, subcommand match, no match.
   - Test `findToolOverride()`: exact match, no match.
   - Test `refresh()`: modify data in store, call refresh, verify cache reflects changes.
   - Test `invalidateTrustRuleV3Cache()`: global invalidation function works.
   - Test `getAllForTool()`: returns correct subset.

### Acceptance criteria
- `TrustRuleV3Cache` loaded from `TrustRuleV3Store` on init
- `findBaseRisk()` supports exact match, path-stripped, and subcommand patterns
- `findToolOverride()` provides simple exact-match lookup for non-bash classifiers
- `invalidateTrustRuleV3Cache()` triggers a full refresh from the store
- `resetTrustRuleV3Cache()` available for tests
- All tests pass

## PR 5: HTTP CRUD routes for risk rules
### Depends on
PR 2, PR 4

### Branch
v3-trust-rules/pr-5-http-routes

### Title
feat(gateway): add HTTP CRUD routes for risk rules

### Files
- gateway/src/http/routes/trust-rules-v3.ts
- gateway/src/__tests__/trust-rules-v3-routes.test.ts
- gateway/src/index.ts

### Implementation steps
1. Create `gateway/src/http/routes/trust-rules-v3.ts`:
   - Import `TrustRuleV3Store` from `../../db/trust-rule-v3-store.js`.
   - Import `invalidateTrustRuleV3Cache` from `../../risk/trust-rule-v3-cache.js`.
   - Import `getMergedFeatureFlags` from `../../ipc/feature-flag-handlers.js`.
   - Add a helper to check the `permission-controls-v3` flag:
     ```typescript
     function requireV3Flag(): Response | null {
       if (!getMergedFeatureFlags()["permission-controls-v3"]) {
         return Response.json({ error: "Feature not enabled" }, { status: 403 });
       }
       return null;
     }
     ```

   - `createTrustRuleV3sListHandler()`: Returns handler for `GET /v1/trust-rules-v3`.
     - Parse query params: `origin`, `tool`, `include_deleted`.
     - Default: excludes soft-deleted rules AND defaults (only returns user_defined + user_modified defaults).
     - With `?origin=default`: includes all defaults.
     - With `?include_deleted=true`: includes soft-deleted.
     - Always available (no feature flag gate on reads).
     - Returns `{ rules: TrustRuleV3[] }`.

   - `createTrustRuleV3sCreateHandler()`: Returns handler for `POST /v1/trust-rules-v3`.
     - Gated behind `permission-controls-v3` flag.
     - Body: `{ tool, pattern, risk, description }`.
     - Validates all fields are non-empty strings, risk is one of low/medium/high.
     - Calls `store.create()`, then `invalidateTrustRuleV3Cache()`.
     - Returns `{ rule: TrustRuleV3 }` with status 201.

   - `createTrustRuleV3sUpdateHandler()`: Returns handler for `PATCH /v1/trust-rules-v3/:id`.
     - Gated behind `permission-controls-v3` flag.
     - Body: `{ risk?, description? }`. At least one must be provided.
     - Validates risk is one of low/medium/high if provided.
     - Calls `store.update()`, then `invalidateTrustRuleV3Cache()`.
     - Returns `{ rule: TrustRuleV3 }`.
     - Returns 404 if not found.

   - `createTrustRuleV3sDeleteHandler()`: Returns handler for `DELETE /v1/trust-rules-v3/:id`.
     - Gated behind `permission-controls-v3` flag.
     - Calls `store.remove()`, then `invalidateTrustRuleV3Cache()`.
     - Returns `{ success: true }`.
     - Returns 404 if not found.

   - `createTrustRuleV3sResetHandler()`: Returns handler for `POST /v1/trust-rules-v3/:id/reset`.
     - Gated behind `permission-controls-v3` flag.
     - Only for `origin="default"` rules.
     - Looks up the original risk from `DEFAULT_COMMAND_REGISTRY` using the rule's pattern.
     - Calls `store.reset(id, originalRisk)`, then `invalidateTrustRuleV3Cache()`.
     - Returns `{ rule: TrustRuleV3 }`.
     - Returns 400 if origin is not "default".
     - Returns 404 if not found.

2. In `gateway/src/index.ts`:
   - Add imports for the new handlers:
     ```typescript
     import {
       createTrustRuleV3sListHandler,
       createTrustRuleV3sCreateHandler,
       createTrustRuleV3sUpdateHandler,
       createTrustRuleV3sDeleteHandler,
       createTrustRuleV3sResetHandler,
     } from "./http/routes/trust-rules-v3.js";
     ```
   - Add imports for risk rule cache initialization:
     ```typescript
     import { initTrustRuleV3Cache } from "./risk/trust-rule-v3-cache.js";
     ```
   - After `await initGatewayDb()`, add:
     ```typescript
     initTrustRuleV3Cache();
     ```
   - Create handler instances in the handler section:
     ```typescript
     const handleTrustRuleV3sList = createTrustRuleV3sListHandler();
     const handleTrustRuleV3sCreate = createTrustRuleV3sCreateHandler();
     const handleTrustRuleV3sUpdate = createTrustRuleV3sUpdateHandler();
     const handleTrustRuleV3sDelete = createTrustRuleV3sDeleteHandler();
     const handleTrustRuleV3sReset = createTrustRuleV3sResetHandler();
     ```
   - Add routes to the route table (before the trust-rules section):
     ```typescript
     // ── Risk rules (V3 classification) ──
     {
       path: /^\/v1\/trust-rules-v3\/([^/]+)\/reset$/,
       method: "POST",
       auth: "edge",
       handler: (req, params) => handleTrustRuleV3sReset(req, params[0]),
     },
     {
       path: "/v1/trust-rules-v3",
       method: "GET",
       auth: "edge",
       handler: (req) => handleTrustRuleV3sList(req),
     },
     {
       path: "/v1/trust-rules-v3",
       method: "POST",
       auth: "edge",
       handler: (req) => handleTrustRuleV3sCreate(req),
     },
     {
       path: /^\/v1\/trust-rules-v3\/([^/]+)$/,
       method: "PATCH",
       auth: "edge",
       handler: (req, params) => handleTrustRuleV3sUpdate(req, params[0]),
     },
     {
       path: /^\/v1\/trust-rules-v3\/([^/]+)$/,
       method: "DELETE",
       auth: "edge",
       handler: (req, params) => handleTrustRuleV3sDelete(req, params[0]),
     },
     ```
   - Note: the `/reset` sub-route MUST be registered before the `/:id` catch-all regex to avoid the regex matching "reset" as an ID.

3. Create `gateway/src/__tests__/trust-rules-v3-routes.test.ts`:
   - Test GET list: default filtering, with `?origin=default`, with `?tool=bash`, with `?include_deleted=true`.
   - Test POST create: valid body, missing fields (400), invalid risk value (400), flag disabled (403).
   - Test PATCH update: valid update, not found (404), flag disabled (403).
   - Test DELETE: user-defined (hard delete), default (soft delete), not found (404), flag disabled (403).
   - Test POST reset: default rule (success), user-defined rule (400), not found (404), flag disabled (403).
   - Test cache invalidation: create a rule, verify cache is refreshed (the findBaseRisk returns the new rule).

### Acceptance criteria
- All 5 HTTP endpoints work correctly
- Write endpoints (POST, PATCH, DELETE, POST /reset) are gated behind `permission-controls-v3` flag
- GET list returns the correct subset based on query filters
- Cache is invalidated after every mutation
- Reset restores original risk from DEFAULT_COMMAND_REGISTRY
- All tests pass

## PR 6: Refactor bash classifier to read base risk from cache
### Depends on
PR 4

### Branch
v3-trust-rules/pr-6-classifier-cache

### Title
feat(gateway): refactor bash classifier to read base risk from risk rule cache

### Files
- gateway/src/risk/bash-risk-classifier.ts
- gateway/src/__tests__/bash-risk-classifier.test.ts

### Implementation steps
1. In `gateway/src/risk/bash-risk-classifier.ts`:
   - Import `getTrustRuleV3Cache` from `./trust-rule-v3-cache.js`.
   - In `classifySegment()`, after the user rules check (step 1) and before the registry lookup (step 2), add a cache lookup:
     ```typescript
     // 1.5. Check risk rule cache (SQLite-backed risk levels)
     // This replaces the hardcoded registry lookup for commands that have
     // entries in the trust_rules table (seeded from DEFAULT_COMMAND_REGISTRY
     // or user-defined).
     try {
       const cachedRule = getTrustRuleV3Cache().findBaseRisk("bash", programName);
       if (cachedRule) {
         // For subcommand resolution, we still need the registry spec for
         // argRules, subcommands, isWrapper, etc. The cache only overrides
         // the baseRisk. Look up the registry spec for structural data.
         // ... (see below)
       }
     } catch {
       // Cache not initialized (e.g., in tests) — fall through to registry
     }
     ```
   - The cache lookup is subtle: the risk rules table stores base risk per command/subcommand, but the classifier also needs `argRules`, `subcommands`, `isWrapper`, `sandboxAutoApprove`, etc. from the registry. So the cache only overrides `baseRisk` — structural data still comes from the registry.
   - Implementation approach: after looking up the registry spec (step 2), check the cache for a risk override. If the cache has an entry, replace `spec.baseRisk` with the cached risk:
     ```typescript
     // After resolving spec from registry:
     let effectiveBaseRisk = resolvedSpec.baseRisk;
     let effectiveMatchType: RiskAssessment["matchType"] = "registry";

     try {
       // Check cache for the resolved command pattern (e.g., "git push")
       const subcommandPattern = subcommand
         ? `${programName} ${subcommandName}`
         : programName;
       const cachedRule = getTrustRuleV3Cache().findBaseRisk("bash", subcommandPattern);
       if (cachedRule) {
         effectiveBaseRisk = cachedRule.risk;
         if (cachedRule.userModified || cachedRule.origin === "user_defined") {
           effectiveMatchType = "user_rule";
         }
       }
     } catch {
       // Cache not initialized — use registry baseRisk
     }
     ```
   - Use `effectiveBaseRisk` instead of `resolvedSpec.baseRisk` in the risk calculation (step 5 and beyond).
   - Use `effectiveMatchType` as the returned `matchType` when the cached rule determined the risk.
   - Also update `generateScopeOptions()`: it still uses `DEFAULT_COMMAND_REGISTRY` for structural data (subcommand detection, argSchema). The scope option generation doesn't need cache — it uses registry for command structure, not risk levels.

2. In `gateway/src/__tests__/bash-risk-classifier.test.ts`:
   - Add tests for cache integration:
     - Test that a user-modified risk rule overrides the registry's baseRisk.
     - Test that `matchType` is `"user_rule"` when a user-modified rule determines the risk.
     - Test that arg rules still apply on top of the cached baseRisk (e.g., `git push --force` still escalates to high even if `git push` base risk is lowered to low).
     - Test fallback: when cache is not initialized (throws), falls through to registry.
     - Test subcommand resolution: `git push` looks up `"git push"` in cache, not just `"git"`.

### Acceptance criteria
- `classifySegment()` checks the risk rule cache before using registry baseRisk
- Cache only overrides `baseRisk` — structural data (argRules, subcommands, isWrapper) still comes from registry
- `matchType` is `"user_rule"` when the winning risk comes from a user-modified or user-defined rule
- Arg rule escalation/de-escalation still works correctly on top of cached baseRisk
- Graceful fallback when cache is not initialized (e.g., in tests without DB)
- Existing tests still pass with the cache fallback
- New tests verify cache integration

## PR 7: Non-bash classifier user overrides from risk rule cache
### Depends on
PR 4

### Branch
v3-trust-rules/pr-7-nonbash-overrides

### Title
feat(gateway): add risk rule cache overrides for non-bash classifiers

### Files
- gateway/src/risk/file-risk-classifier.ts
- gateway/src/risk/web-risk-classifier.ts
- gateway/src/risk/skill-risk-classifier.ts
- gateway/src/risk/schedule-risk-classifier.ts
- gateway/src/__tests__/nonbash-trust-rule-v3-overrides.test.ts

### Implementation steps
1. In each non-bash classifier (`file-risk-classifier.ts`, `web-risk-classifier.ts`, `skill-risk-classifier.ts`, `schedule-risk-classifier.ts`), add a user override check after the normal classification logic:
   - Import `getTrustRuleV3Cache` from `./trust-rule-v3-cache.js`.
   - At the end of the `classify()` method, before returning the assessment, check for a user-defined risk rule override:
     ```typescript
     // Check risk rule cache for user overrides
     try {
       const cache = getTrustRuleV3Cache();
       const override = cache.findToolOverride(toolName, <pattern>);
       if (override && (override.userModified || override.origin === "user_defined")) {
         return {
           ...assessment,
           riskLevel: override.risk,
           reason: override.description,
           matchType: "user_rule",
         };
       }
     } catch {
       // Cache not initialized — no override
     }
     ```
   - For each classifier, determine what `<pattern>` means:
     - **File classifiers** (`file_read`, `file_write`, `file_edit`, `host_file_read`, `host_file_write`, `host_file_edit`): pattern is the resolved file path (e.g., `/Users/foo/project/src/index.ts`).
     - **Web classifiers** (`web_fetch`, `network_request`, `web_search`): pattern is the URL.
     - **Skill classifiers** (`skill_load`, `scaffold_managed_skill`, `delete_managed_skill`): pattern is the skill selector.
     - **Schedule classifiers** (`schedule_create`, `schedule_update`): pattern is the mode or script.

2. Create `gateway/src/__tests__/nonbash-trust-rule-v3-overrides.test.ts`:
   - Set up a test DB with risk rules for each tool type.
   - Test file classifier: user rule overrides default risk for a specific file path.
   - Test web classifier: user rule overrides default risk for a specific URL.
   - Test skill classifier: user rule overrides default risk for a skill selector.
   - Test schedule classifier: user rule overrides default risk for a mode.
   - Test that non-user rules (origin=default, userModified=false) do NOT override the classifier's built-in logic.
   - Test graceful fallback when cache is not initialized.

### Acceptance criteria
- All four non-bash classifiers check the risk rule cache for user overrides
- Only user-modified or user-defined rules trigger overrides (not unmodified defaults)
- `matchType` is `"user_rule"` when an override is applied
- Override pattern matching uses the appropriate tool-specific identifier
- Graceful fallback when cache is not initialized
- Existing classifier tests still pass
- New override tests pass
