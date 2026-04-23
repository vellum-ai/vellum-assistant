# V3 Trust Rules: SQLite Table, Seeding, HTTP CRUD, and Classifier Integration

## Overview
Phase 2 of the V3 Trust Rules project. Adds a persistent SQLite `risk_rules` table seeded from the existing `DEFAULT_COMMAND_REGISTRY`, exposes HTTP CRUD endpoints for the macOS client (behind `permission-controls-v3` feature flag), and refactors the gateway classifiers to read base risk from the table instead of the in-code registry. User-modified and soft-deleted rules survive gateway restarts. The registry upsert on startup respects three guards (origin=default, user_modified=0, deleted=0) so user customizations are never overwritten.

**Naming convention:** The new system is called `risk_rules` (not `trust_rules`) to avoid confusion with the existing file-backed allow/deny/ask trust rules at `gateway/src/trust-store.ts` and `/v1/trust-rules`. The existing system manages permission decisions (allow/deny/ask); the new system manages risk classification levels (low/medium/high). They operate at different layers of the permission pipeline and coexist.

**API path:** `/v1/risk-rules` (not `/v1/trust-rules`, which is already in use for the allow/deny trust rule CRUD).

## PR 1: Add risk_rules Drizzle table schema
### Depends on
None

### Branch
v3-risk-rules/pr-1-drizzle-schema

### Title
feat(gateway): add risk_rules Drizzle table schema

### Files
- gateway/src/db/schema.ts

### Implementation steps
1. In `gateway/src/db/schema.ts`, add a new table definition after the `conversationThresholdOverrides` table:
   ```typescript
   export const riskRules = sqliteTable(
     "risk_rules",
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
       index("idx_risk_rules_tool_pattern").on(table.tool, table.pattern),
     ],
   );
   ```
   Use a unique index on `(tool, pattern)` via Drizzle's `uniqueIndex` helper:
   ```typescript
   import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
   ```
   Replace the regular `index` with `uniqueIndex("idx_risk_rules_tool_pattern")`.

2. Import `uniqueIndex` from `drizzle-orm/sqlite-core` (it should already have `index` imported — add `uniqueIndex` to the existing import).

### Acceptance criteria
- `riskRules` table exported from `schema.ts`
- Table has all 10 columns: id, tool, pattern, risk, description, origin, user_modified, deleted, created_at, updated_at
- `(tool, pattern)` has a unique index
- `user_modified` and `deleted` use integer boolean mode
- `initGatewayDb()` auto-pushes the new table on next startup (no migration files needed)

## PR 2: Create RiskRuleStore with CRUD operations
### Depends on
PR 1

### Branch
v3-risk-rules/pr-2-risk-rule-store

### Title
feat(gateway): add RiskRuleStore with SQLite CRUD operations

### Files
- gateway/src/db/risk-rule-store.ts
- gateway/src/__tests__/risk-rule-store.test.ts

### Implementation steps
1. Create `gateway/src/db/risk-rule-store.ts` with a `RiskRuleStore` class following the existing store pattern (see `gateway/src/db/contact-store.ts`):
   - Constructor accepts optional `GatewayDb` for test injection, otherwise uses `getGatewayDb()`.
   - Define a `RiskRule` TypeScript interface matching the response shape:
     ```typescript
     export interface RiskRule {
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
   - `list(filters?: { origin?: string; tool?: string; includeDeleted?: boolean })`: Returns `RiskRule[]`. By default excludes soft-deleted rules. When `origin` is provided, filters by origin. When `tool` is provided, filters by tool. When `includeDeleted` is true, includes soft-deleted.
   - `getById(id: string)`: Returns `RiskRule | null`.
   - `create(input: { tool: string; pattern: string; risk: string; description: string })`: Creates a user-defined rule. Sets `origin="user_defined"`, `userModified=false`, `deleted=false`. Generates a UUIDv4 `id`. Sets `createdAt` and `updatedAt` to current ISO 8601 UTC. Returns the created `RiskRule`.
   - `update(id: string, updates: { risk?: string; description?: string })`: Updates an existing rule. If the rule has `origin="default"`, sets `userModified=true`. Updates `updatedAt`. Returns the updated `RiskRule`. Throws if not found.
   - `remove(id: string)`: For `origin="user_defined"` rules, hard-deletes (DELETE FROM). For `origin="default"` rules, soft-deletes (sets `deleted=true`, updates `updatedAt`). Returns `boolean` (true if found). Throws if not found.
   - `reset(id: string)`: Only for `origin="default"` rules. Clears `userModified` (set to false), clears `deleted` (set to false), updates `updatedAt`. Does NOT restore the original risk from the registry (the caller must provide the original risk). Instead, accepts `originalRisk` parameter and sets `risk` to that value. Returns the reset `RiskRule`. Throws if not found or if origin is not "default".
   - `upsertDefault(input: { id: string; tool: string; pattern: string; risk: string; description: string })`: Inserts a default rule. On conflict `(tool, pattern)`, updates risk and description ONLY IF `origin='default' AND user_modified=0 AND deleted=0`. This implements the three-guard upsert. Uses raw SQL via `db.run(sql\`...\`)` for the conditional ON CONFLICT clause.
   - `listActive(tool?: string)`: Returns all active (non-deleted) rules, optionally filtered by tool. This is the query the cache will use.

2. Create `gateway/src/__tests__/risk-rule-store.test.ts`:
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
- `RiskRuleStore` class exported with all CRUD methods
- `RiskRule` interface matches the specified response shape
- Deterministic IDs for defaults (format: `default:<tool>:<pattern-slug>`)
- UUIDv4 IDs for user-defined rules
- Three-guard upsert respects `origin=default AND user_modified=0 AND deleted=0`
- Soft-delete for defaults, hard-delete for user-defined
- All tests pass

## PR 3: Seed risk_rules from DEFAULT_COMMAND_REGISTRY
### Depends on
PR 2

### Branch
v3-risk-rules/pr-3-seed-from-registry

### Title
feat(gateway): seed risk_rules table from DEFAULT_COMMAND_REGISTRY on startup

### Files
- gateway/src/db/seed-risk-rules.ts
- gateway/src/__tests__/seed-risk-rules.test.ts
- gateway/src/db/connection.ts

### Implementation steps
1. Create `gateway/src/db/seed-risk-rules.ts`:
   - Import `DEFAULT_COMMAND_REGISTRY` from `../risk/command-registry.js` and `RiskRuleStore` from `./risk-rule-store.js`.
   - Export `seedRiskRulesFromRegistry(store: RiskRuleStore)`.
   - Walk the registry and produce one row per top-level command and one row per subcommand (recursively). For each entry:
     - `tool`: `"bash"` (the registry entries apply to bash/host_bash tools)
     - `pattern`: For top-level: the command name (e.g., `"ls"`, `"git"`). For subcommands: `"<parent> <sub>"` (e.g., `"git push"`, `"git stash drop"`).
     - `risk`: The `baseRisk` from the `CommandRiskSpec`.
     - `description`: Use `spec.reason` if present, otherwise generate from the command name (e.g., `"ls (default)"`, `"git push"`, `"sudo — Elevates to superuser privileges"`).
     - `id`: Deterministic format `default:bash:<command-slug>` where `<command-slug>` is the pattern with spaces replaced by hyphens (e.g., `default:bash:git-push`).
   - Call `store.upsertDefault()` for each entry. The three-guard upsert ensures user modifications are preserved.
   - Return the count of rows upserted for logging.

2. In `gateway/src/db/connection.ts`, after `runDataMigrations(getRawDb(db))` in `initGatewayDb()`:
   - Import `seedRiskRulesFromRegistry` and `RiskRuleStore`.
   - After data migrations, call:
     ```typescript
     const riskRuleStore = new RiskRuleStore(db);
     await seedRiskRulesFromRegistry(riskRuleStore);
     ```
   - Note: `seedRiskRulesFromRegistry` is synchronous (Drizzle operations are sync with bun:sqlite), but keep async signature for future-proofing.

3. Create `gateway/src/__tests__/seed-risk-rules.test.ts`:
   - Test that seeding creates rows for all registry entries (top-level + subcommands).
   - Test that re-seeding (calling seed twice) is idempotent — same number of active rules.
   - Test three-guard protection: modify a rule's risk, re-seed, verify the modified rule is NOT overwritten.
   - Test three-guard with deleted: soft-delete a rule, re-seed, verify NOT restored.
   - Test that deterministic IDs are consistent across re-seeds.
   - Test that the count returned is reasonable (check it's > 200 for the current registry size).

### Acceptance criteria
- `seedRiskRulesFromRegistry()` transforms the full DEFAULT_COMMAND_REGISTRY into risk_rules rows
- Each top-level command and each subcommand gets its own row
- Deterministic IDs follow `default:bash:<slug>` format
- Three-guard upsert protects user modifications on re-seed
- Seeding is wired into `initGatewayDb()` so it runs on every startup
- Re-seeding is idempotent for unmodified rules

## PR 4: In-memory risk rule cache with invalidation
### Depends on
PR 2

### Branch
v3-risk-rules/pr-4-risk-rule-cache

### Title
feat(gateway): add in-memory risk rule cache with invalidation

### Files
- gateway/src/risk/risk-rule-cache.ts
- gateway/src/__tests__/risk-rule-cache.test.ts

### Implementation steps
1. Create `gateway/src/risk/risk-rule-cache.ts`:
   - Import `RiskRuleStore` and `RiskRule` from `../db/risk-rule-store.js`.
   - Export a singleton pattern:
     ```typescript
     let cache: RiskRuleCache | null = null;

     export function initRiskRuleCache(store?: RiskRuleStore): void {
       cache = new RiskRuleCache(store ?? new RiskRuleStore());
     }

     export function getRiskRuleCache(): RiskRuleCache {
       if (!cache) throw new Error("Risk rule cache not initialized — call initRiskRuleCache() at startup");
       return cache;
     }

     export function invalidateRiskRuleCache(): void {
       cache?.refresh();
     }

     export function resetRiskRuleCache(): void {
       cache = null;
     }
     ```
   - `RiskRuleCache` class:
     - Constructor takes `RiskRuleStore`.
     - On construction, calls `refresh()` to load initial data.
     - Internal data structure: `Map<string, Map<string, RiskRule>>` keyed by `tool` then `pattern`.
     - `refresh()`: Clears the maps, calls `store.listActive()`, rebuilds the maps.
     - `findBaseRisk(tool: string, command: string): RiskRule | null`: Looks up by exact match on `(tool, command)`. Returns the matching `RiskRule` or null. For bash tools, also tries stripping path prefixes (e.g., `/usr/bin/rm` → `rm`) and resolving subcommand patterns (e.g., for command `git push`, tries `"git push"` then `"git"`).
     - `findToolOverride(tool: string, pattern: string): RiskRule | null`: For non-bash classifiers. Looks up by `(tool, pattern)` exact match. Used for file/web/skill/schedule user overrides.
     - `getAllForTool(tool: string): RiskRule[]`: Returns all active rules for a given tool.

2. Create `gateway/src/__tests__/risk-rule-cache.test.ts`:
   - Test `findBaseRisk()`: exact match, path-stripped match, subcommand match, no match.
   - Test `findToolOverride()`: exact match, no match.
   - Test `refresh()`: modify data in store, call refresh, verify cache reflects changes.
   - Test `invalidateRiskRuleCache()`: global invalidation function works.
   - Test `getAllForTool()`: returns correct subset.

### Acceptance criteria
- `RiskRuleCache` loaded from `RiskRuleStore` on init
- `findBaseRisk()` supports exact match, path-stripped, and subcommand patterns
- `findToolOverride()` provides simple exact-match lookup for non-bash classifiers
- `invalidateRiskRuleCache()` triggers a full refresh from the store
- `resetRiskRuleCache()` available for tests
- All tests pass

## PR 5: HTTP CRUD routes for risk rules
### Depends on
PR 2, PR 4

### Branch
v3-risk-rules/pr-5-http-routes

### Title
feat(gateway): add HTTP CRUD routes for risk rules

### Files
- gateway/src/http/routes/risk-rules.ts
- gateway/src/__tests__/risk-rules-routes.test.ts
- gateway/src/index.ts

### Implementation steps
1. Create `gateway/src/http/routes/risk-rules.ts`:
   - Import `RiskRuleStore` from `../../db/risk-rule-store.js`.
   - Import `invalidateRiskRuleCache` from `../../risk/risk-rule-cache.js`.
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

   - `createRiskRulesListHandler()`: Returns handler for `GET /v1/risk-rules`.
     - Parse query params: `origin`, `tool`, `include_deleted`.
     - Default: excludes soft-deleted rules AND defaults (only returns user_defined + user_modified defaults).
     - With `?origin=default`: includes all defaults.
     - With `?include_deleted=true`: includes soft-deleted.
     - Always available (no feature flag gate on reads).
     - Returns `{ rules: RiskRule[] }`.

   - `createRiskRulesCreateHandler()`: Returns handler for `POST /v1/risk-rules`.
     - Gated behind `permission-controls-v3` flag.
     - Body: `{ tool, pattern, risk, description }`.
     - Validates all fields are non-empty strings, risk is one of low/medium/high.
     - Calls `store.create()`, then `invalidateRiskRuleCache()`.
     - Returns `{ rule: RiskRule }` with status 201.

   - `createRiskRulesUpdateHandler()`: Returns handler for `PATCH /v1/risk-rules/:id`.
     - Gated behind `permission-controls-v3` flag.
     - Body: `{ risk?, description? }`. At least one must be provided.
     - Validates risk is one of low/medium/high if provided.
     - Calls `store.update()`, then `invalidateRiskRuleCache()`.
     - Returns `{ rule: RiskRule }`.
     - Returns 404 if not found.

   - `createRiskRulesDeleteHandler()`: Returns handler for `DELETE /v1/risk-rules/:id`.
     - Gated behind `permission-controls-v3` flag.
     - Calls `store.remove()`, then `invalidateRiskRuleCache()`.
     - Returns `{ success: true }`.
     - Returns 404 if not found.

   - `createRiskRulesResetHandler()`: Returns handler for `POST /v1/risk-rules/:id/reset`.
     - Gated behind `permission-controls-v3` flag.
     - Only for `origin="default"` rules.
     - Looks up the original risk from `DEFAULT_COMMAND_REGISTRY` using the rule's pattern.
     - Calls `store.reset(id, originalRisk)`, then `invalidateRiskRuleCache()`.
     - Returns `{ rule: RiskRule }`.
     - Returns 400 if origin is not "default".
     - Returns 404 if not found.

2. In `gateway/src/index.ts`:
   - Add imports for the new handlers:
     ```typescript
     import {
       createRiskRulesListHandler,
       createRiskRulesCreateHandler,
       createRiskRulesUpdateHandler,
       createRiskRulesDeleteHandler,
       createRiskRulesResetHandler,
     } from "./http/routes/risk-rules.js";
     ```
   - Add imports for risk rule cache initialization:
     ```typescript
     import { initRiskRuleCache } from "./risk/risk-rule-cache.js";
     ```
   - After `await initGatewayDb()`, add:
     ```typescript
     initRiskRuleCache();
     ```
   - Create handler instances in the handler section:
     ```typescript
     const handleRiskRulesList = createRiskRulesListHandler();
     const handleRiskRulesCreate = createRiskRulesCreateHandler();
     const handleRiskRulesUpdate = createRiskRulesUpdateHandler();
     const handleRiskRulesDelete = createRiskRulesDeleteHandler();
     const handleRiskRulesReset = createRiskRulesResetHandler();
     ```
   - Add routes to the route table (before the trust-rules section):
     ```typescript
     // ── Risk rules (V3 classification) ──
     {
       path: /^\/v1\/risk-rules\/([^/]+)\/reset$/,
       method: "POST",
       auth: "edge",
       handler: (req, params) => handleRiskRulesReset(req, params[0]),
     },
     {
       path: "/v1/risk-rules",
       method: "GET",
       auth: "edge",
       handler: (req) => handleRiskRulesList(req),
     },
     {
       path: "/v1/risk-rules",
       method: "POST",
       auth: "edge",
       handler: (req) => handleRiskRulesCreate(req),
     },
     {
       path: /^\/v1\/risk-rules\/([^/]+)$/,
       method: "PATCH",
       auth: "edge",
       handler: (req, params) => handleRiskRulesUpdate(req, params[0]),
     },
     {
       path: /^\/v1\/risk-rules\/([^/]+)$/,
       method: "DELETE",
       auth: "edge",
       handler: (req, params) => handleRiskRulesDelete(req, params[0]),
     },
     ```
   - Note: the `/reset` sub-route MUST be registered before the `/:id` catch-all regex to avoid the regex matching "reset" as an ID.

3. Create `gateway/src/__tests__/risk-rules-routes.test.ts`:
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
v3-risk-rules/pr-6-classifier-cache

### Title
feat(gateway): refactor bash classifier to read base risk from risk rule cache

### Files
- gateway/src/risk/bash-risk-classifier.ts
- gateway/src/__tests__/bash-risk-classifier.test.ts

### Implementation steps
1. In `gateway/src/risk/bash-risk-classifier.ts`:
   - Import `getRiskRuleCache` from `./risk-rule-cache.js`.
   - In `classifySegment()`, after the user rules check (step 1) and before the registry lookup (step 2), add a cache lookup:
     ```typescript
     // 1.5. Check risk rule cache (SQLite-backed risk levels)
     // This replaces the hardcoded registry lookup for commands that have
     // entries in the risk_rules table (seeded from DEFAULT_COMMAND_REGISTRY
     // or user-defined).
     try {
       const cachedRule = getRiskRuleCache().findBaseRisk("bash", programName);
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
       const cachedRule = getRiskRuleCache().findBaseRisk("bash", subcommandPattern);
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
v3-risk-rules/pr-7-nonbash-overrides

### Title
feat(gateway): add risk rule cache overrides for non-bash classifiers

### Files
- gateway/src/risk/file-risk-classifier.ts
- gateway/src/risk/web-risk-classifier.ts
- gateway/src/risk/skill-risk-classifier.ts
- gateway/src/risk/schedule-risk-classifier.ts
- gateway/src/__tests__/nonbash-risk-rule-overrides.test.ts

### Implementation steps
1. In each non-bash classifier (`file-risk-classifier.ts`, `web-risk-classifier.ts`, `skill-risk-classifier.ts`, `schedule-risk-classifier.ts`), add a user override check after the normal classification logic:
   - Import `getRiskRuleCache` from `./risk-rule-cache.js`.
   - At the end of the `classify()` method, before returning the assessment, check for a user-defined risk rule override:
     ```typescript
     // Check risk rule cache for user overrides
     try {
       const cache = getRiskRuleCache();
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

2. Create `gateway/src/__tests__/nonbash-risk-rule-overrides.test.ts`:
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
