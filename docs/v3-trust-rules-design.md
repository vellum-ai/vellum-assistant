# V3 Trust Rules — Design Doc

> **Status:** Draft
> **Authors:** Noa, Credence
> **Date:** 2026-04-22 (revised 2026-04-23)
> **Related:** bash-risk-classifier-design.md, scope-ladder.md

## 1. Overview

V3 trust rules replace the v1 trust rule system with a risk-level-first model.
Instead of storing imperative decisions (`allow` / `deny` / `ask`), v3 rules
store **risk classifications** (`low` / `medium` / `high`). The approval policy
then decides what to do based on the user's auto-approve threshold and execution
context.

This is a **clean break** from v1. No dual-write, no backfill, no migration.
V1 rules remain in `trust.json` as a fallback when no v3 rule matches. When
the `permission-controls-v3` flag is permanently on, v1 rules can be retired
via a one-time user-initiated migration prompt (out of scope for this doc).

### 1.1 Architecture Change: Gateway-Owned Classification

The risk classification pipeline (shell parsing, command registry, arg rules,
scope option generation) moves from the assistant to the gateway. The assistant
becomes a thin client: it sends a raw command string over IPC and receives a
complete `RiskAssessment` back.

This powers **both v1 and v3 permission paths** — no parallel classification
systems. V1 users get the data-driven registry classifier for free. V3 resolves
user overrides server-side in the same call.

## 2. Mental Model

```
                        Gateway (IPC)
┌────────────┐    ┌─────────────────────────────────────────────┐
│  Assistant  │    │  Shell Parser (tree-sitter-bash WASM)       │
│            │    │         ↓                                   │
│  Sends raw  │───▶│  Classifier (registry + arg rules)          │
│  command    │    │         ↓                                   │
│  string     │    │  Trust Rules V3 (SQLite, user overrides)    │
│            │    │         ↓                                   │
│  Receives   │◀───│  RiskAssessment                             │
│  assessment │    │  { risk, reason, scopeOptions, ... }        │
│            │    └─────────────────────────────────────────────┘
│  Applies    │
│  approval   │    The gateway owns the ENTIRE risk pipeline.
│  policy     │    The assistant only applies policy + shows UI.
└────────────┘
```

**Three distinct concerns:**

1. **Classification** — "what risk level is this command?" (gateway: parser + classifier + registry + user overrides)
2. **Policy** — "given this risk level, should we auto-approve or prompt?" (assistant: threshold + context)
3. **UI** — "show the user what happened and let them act" (client: permission prompt, trust rules manager)

## 3. IPC Classification Endpoint

### 3.1 Transport

The assistant and gateway communicate over a Unix domain socket using
newline-delimited JSON (the same protocol used for feature flags). The socket
lives at `{workspaceDir}/gateway.sock`.

Classification is a **hot path** — called on every tool invocation. The
existing `ipcCall()` is one-shot (connect, call, disconnect), which is fine
for infrequent feature flag checks but adds unnecessary overhead here. Phase 1
introduces a persistent IPC connection variant alongside the existing one-shot
helper.

### 3.2 Protocol

**Request** (assistant → gateway):
```json
{
  "id": "req-1",
  "method": "classify_risk",
  "params": {
    "tool": "bash",
    "command": "git push origin main --force",
    "workingDir": "/Users/noa/project"
  }
}
```

**Response** (gateway → assistant):
```json
{
  "id": "req-1",
  "result": {
    "risk": "high",
    "reason": "git push with --force flag",
    "matchType": "registry",
    "matchedRuleId": "default:bash:git-push",
    "scopeOptions": [
      { "pattern": "^git\\s+push\\s+.*--force\\b", "label": "git push --force" },
      { "pattern": "^git\\s+push\\b", "label": "Any git push" },
      { "pattern": "^git\\b", "label": "Any git command" }
    ],
    "allowlistOptions": [...],
    "dangerousPatterns": [],
    "opaqueConstructs": [],
    "isComplexSyntax": false
  }
}
```

### 3.3 No Fallback

The gateway is a hard dependency — no fallback to in-process classification.
This is the same stance as autoApproveUpTo threshold resolution: if the gateway
is down, the assistant can't classify risk, and tool calls that need
classification will fail. This avoids maintaining two parallel classification
paths indefinitely.

## 4. Data Model

### 4.1 Schema

A new SQLite table in the gateway database (`gateway.sqlite`), declared in
`gateway/src/db/schema.ts` via Drizzle ORM. Schema push handles DDL
automatically — no migration files needed.

```sql
CREATE TABLE trust_rules (
  id             TEXT    PRIMARY KEY,
  tool           TEXT    NOT NULL,
  pattern        TEXT    NOT NULL,
  risk           TEXT    NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
  description    TEXT    NOT NULL,
  origin         TEXT    NOT NULL CHECK (origin IN ('default', 'user_defined')),
  user_modified  INTEGER NOT NULL DEFAULT 0,
  deleted        INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  UNIQUE(tool, pattern)
);
```

**Column semantics:**

| Column          | Type     | Description |
|-----------------|----------|-------------|
| `id`            | TEXT PK  | UUID for user-created rules. Deterministic ID for defaults (e.g. `default:bash:git-push`). |
| `tool`          | TEXT     | Tool name: `bash`, `host_bash`, `file_read`, `file_write`, etc. Each classifier queries only its own tool's rules. |
| `pattern`       | TEXT     | Regex pattern matching the command/invocation. Same format as the command registry's patterns. Stored as regex internally; displayed as globs in the UI. |
| `risk`          | TEXT     | `low` \| `medium` \| `high`. The user's risk classification for this pattern. |
| `description`   | TEXT     | Human-readable label shown in the Trust Rules Manager (e.g. "Any git push command", "npm install with save"). |
| `origin`        | TEXT     | `default` (seeded from command registry) or `user_defined` (created via permission prompt). **Immutable** — never changes after creation. |
| `user_modified` | INTEGER  | `0` = untouched, `1` = user has edited the risk level. When `1`, registry upserts skip this row. |
| `deleted`       | INTEGER  | Soft-delete flag. `0` = active, `1` = deleted. Defaults are soft-deleted so they don't resurrect on restart. User-defined rules are hard-deleted. |
| `created_at`    | TEXT     | ISO 8601 timestamp. |
| `updated_at`    | TEXT     | ISO 8601 timestamp. Updated on every edit. |

### 4.2 What V3 Rules Do NOT Have

- **`scope`** — Risk is about the command, not where you are. Filesystem location scoping may be a conditional addition later for file-mutating tools, but it's not part of the v3 rule model.
- **`decision`** — Decisions are computed by the approval policy from `risk` + threshold + context.
- **`priority`** — All rules are equal weight. Conflict resolution uses specificity (see §6).
- **`executionTarget`** — V1 concept, not applicable.

### 4.3 Relationship to Existing Types

The `UserRule` type in `risk-types.ts` was designed for this purpose but needs
updates:

```diff
 export interface UserRule {
   id: string;
+  tool: string;
   pattern: string;
   risk: RegistryRisk;
-  label: string;
+  description: string;
   createdAt: string;
-  source: "scope_ladder" | "manual";
+  origin: "default" | "user_defined";
+  userModified: boolean;
 }
```

## 5. Registry Seeding

### 5.1 Startup Upsert

On gateway startup, the command registry (~100 commands, ~290 entries including
subcommands) is upserted into `trust_rules`. Each registry entry produces
one row at its `baseRisk`.

```sql
INSERT INTO trust_rules
  (id, tool, pattern, risk, description, origin, user_modified, deleted, created_at, updated_at)
VALUES
  (?, ?, ?, ?, ?, 'default', 0, 0, ?, ?)
ON CONFLICT (tool, pattern) DO UPDATE SET
  risk        = excluded.risk,
  description = excluded.description,
  updated_at  = excluded.updated_at
WHERE origin = 'default'
  AND user_modified = 0
  AND deleted = 0;
```

**Three guards** prevent overwriting user intent:
1. `origin = 'default'` — only touch registry-seeded rows
2. `user_modified = 0` — user hasn't overridden the risk level
3. `deleted = 0` — user hasn't soft-deleted the row

### 5.2 What Gets Seeded

One row per command (or subcommand) at `baseRisk`:

| Registry Entry | Seeded Row |
|---|---|
| `ls: { baseRisk: "low" }` | `{ tool: "bash", pattern: "^ls\\b", risk: "low", description: "ls (list files)" }` |
| `git.push: { baseRisk: "medium" }` | `{ tool: "bash", pattern: "^git\\s+push\\b", risk: "medium", description: "git push" }` |
| `rm: { baseRisk: "medium" }` | `{ tool: "bash", pattern: "^rm\\b", risk: "medium", description: "rm (remove files)" }` |

**Arg rules stay in code.** The `argRules` array on each `CommandRiskSpec`
(e.g. `rm -rf` → high) remains in the classifier's runtime logic. They
represent conditional risk escalation/de-escalation within a command, not
user-facing rules. The trust_rules table stores the base classification
that the user can override. The classifier still evaluates arg rules at
runtime and may produce a higher risk than the base — a user rule overrides
the *final* risk assessment, not individual arg rules.

### 5.3 Deterministic IDs

Default rows use deterministic IDs for idempotent upserts:

- Format: `default:<tool>:<command>` (e.g. `default:bash:git-push`, `default:bash:rm`)
- Subcommands: `default:<tool>:<command>-<subcommand>` (e.g. `default:bash:git-push`)
- User-created rules use UUIDv4

### 5.4 Registry Updates

When a new Vellum version ships with changed registry risk levels:

- **New commands**: Inserted as new `default` rows.
- **Changed risk levels**: Updated on existing `default` rows *unless* `user_modified = 1` or `deleted = 1`.
- **Removed commands**: Default rows for removed commands persist but become inert (the classifier no longer produces matching patterns). Could be cleaned up via a data migration, but no urgency.

## 6. Matching & Conflict Resolution

### 6.1 Lookup Path

The classifier (now running in the gateway) consults the trust_rules table
directly. The table IS the registry:

1. Load all active rules for the tool into an in-memory cache (refreshed on rule changes)
2. Test each rule's regex `pattern` against the command string
3. If one or more rules match, **most specific wins** (see §6.2)
4. The winning rule's `risk` becomes the base risk level
5. Apply in-code arg rules (may escalate, e.g. `rm -rf` → high)
6. Return final `RiskAssessment`

One lookup path, no double-consultation between table and in-code registry.

### 6.2 Specificity

When multiple rules match (e.g. `^git\b` at low and `^git\s+push\b` at high
both match `git push origin main`):

**Most-specific-pattern wins = longest matching pattern.**

Regex length is a rough but effective proxy for specificity. `^git\s+push\b`
(16 chars) is longer than `^git\b` (6 chars), so the more specific rule wins.

Edge cases where length doesn't perfectly track specificity are rare in
practice — the scope ladder generates patterns at well-defined granularity
levels (command → subcommand → subcommand+args), and these naturally increase
in length as they increase in specificity.

### 6.3 Row Count

- Default registry: ~100 commands × ~2 subcommand average = ~200-300 rows
- User-created rules: Single digits for most users, maybe 50-100 for power users
- Total: A few hundred rows per tool at most
- All loaded into memory per classification: trivially fast

## 7. CRUD Operations

### 7.1 Endpoints (HTTP — Client ↔ Gateway)

New gateway HTTP routes under `/v1/assistants/{assistantId}/trust-rules-v3/`
for the macOS client to manage rules:

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/manage` | List all active rules (`WHERE deleted = 0`). Returns both defaults and user-defined. |
| `PATCH` | `/manage/:id` | Update a rule's risk level. Sets `user_modified = 1` if origin is `default`. |
| `DELETE` | `/manage/:id` | Soft-delete if `origin = 'default'`, hard-delete if `origin = 'user_defined'`. |
| `POST` | `/manage` | Create a new user-defined rule (from permission prompt save flow). |

### 7.2 IPC Methods (Assistant ↔ Gateway)

| Method | Description |
|--------|-------------|
| `classify_risk` | Full classification: parse → classify → user override → scope options. |

The classification IPC method also invalidates the in-memory cache when rules
change (add/update/delete via HTTP triggers a cache refresh).

### 7.3 Reset to Default

A user who edited a default rule's risk level can "reset" it: set
`user_modified = 0` and let the next startup upsert restore the registry value.
Slightly delayed but zero extra code.

### 7.4 Restoring Deleted Defaults

A user who deleted a default rule can "restore" it by un-soft-deleting:

```sql
UPDATE trust_rules SET deleted = 0, updated_at = ? WHERE id = ?;
```

Whether to expose this in the UI is a later decision.

## 8. Client — V3 Trust Rules Manager

### 8.1 Location

Accessible from the "Manage Trust Rules" button on the Privacy & Permissions
settings page. When the `permission-controls-v3` flag is on, the button opens
`V3TrustRulesView` instead of the v1 `TrustRulesView`.

### 8.2 UI Structure

**Header**: "Trust Rules" title, no "Add" button (rules are created from
permission prompts, not from scratch).

**Default view**: Shows only user-origin rules (`origin = 'user_defined'`)
and user-modified defaults (`user_modified = 1`). Opt-in toggle to show all
default rules.

**List**: Flat list of active rules, sorted by tool then description.
Each row shows:
- **Description** (primary text, e.g. "git push", "npm install *")
- **Tool** (secondary/subtle, e.g. "Run Command")
- **Risk badge** (colored capsule: 🟢 Low / 🟡 Medium / 🔴 High) — same style as the permission prompt
- **Origin badge** (subtle, only for defaults: "Default" in muted text)
- **User modified indicator** (if origin=default and user_modified=1, show "Modified" or similar)

**Row actions**:
- **Tap/click**: Opens edit modal — risk level picker only (pattern is read-only). For defaults, also shows a "Reset to Default" option.
- **Delete**: Confirmation dialog → soft-delete (defaults) or hard-delete (user-defined).

**Empty state**: "No trust rules yet. Rules are created when you classify
actions from permission prompts."

### 8.3 Edit Modal

A simplified variant of `V3RuleEditorModal`:
- **Pattern** (read-only display)
- **Description** (read-only display)
- **Risk level picker** (Low / Medium / High — same capsule buttons as the creation flow)
- **"Reset to Default"** button (only for default-origin rules with `user_modified = 1`)
- **Save** button

### 8.4 Grouping / Filtering (Future)

For v1, flat list is fine. As the rule count grows, could add:
- Filter by tool
- Filter by risk level
- Search by description/pattern
- Group by tool

## 9. Relationship to V1 Trust Rules

### 9.1 Coexistence

Both systems operate simultaneously. The gateway classification endpoint
handles risk assessment (consulting trust_rules internally). The assistant
still has v1 trust rules as a fallback for the approval policy layer:

1. Assistant calls gateway `classify_risk` IPC → gateway parses, classifies,
   checks trust_rules, returns `RiskAssessment`
2. Assistant applies approval policy (threshold + context → auto-approve or prompt)
3. If the approval policy doesn't have a definitive answer, v1 trust rules
   (`trust.json`) serve as legacy fallback

### 9.2 Flag Rollback Safety

If `permission-controls-v3` is killed:
- The `classify_risk` IPC endpoint still works (it's not flag-gated — it powers v1 too)
- V3 trust rules (user overrides) become inert in the classification
- V1 trust rules in `trust.json` resume full control
- No data loss — v3 rules remain in SQLite for when the flag comes back
- User-created v3 rules are invisible but preserved

### 9.3 Eventual V1 Deprecation (Out of Scope)

When v3 is permanently on:
- Offer one-time migration: present v1 rules, let user review and import as v3
- `allow` → `low`, `ask` → `medium`, `deny` → `high` (lossy but reasonable defaults)
- User confirms each or bulk-imports
- After import, v1 trust file becomes inactive

## 10. Audit Trail (Future)

Not building now, but the schema is designed to support it. Future table:

```sql
CREATE TABLE trust_rules_audit (
  id         TEXT PRIMARY KEY,
  rule_id    TEXT NOT NULL,
  action     TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'restore')),
  field      TEXT,
  old_value  TEXT,
  new_value  TEXT,
  created_at TEXT NOT NULL
);
```

The `updated_at` column on `trust_rules` provides a minimal audit signal
in the interim.

## 11. Implementation Phases

Each phase is a standalone Claude Code `/create-plan` session and PR chain.

---

### Phase 1: Move Risk Pipeline to Gateway

**Goal:** Move the shell parser, command registry, arg parser, risk classifier,
and scope option generation from the assistant to the gateway. Expose a
`classify_risk` IPC method. The assistant calls it instead of classifying
locally.

**What moves to `gateway/`:**
- `assistant/src/tools/terminal/parser.ts` → `gateway/src/risk/shell-parser.ts`
  (tree-sitter-bash WASM initialization, ParsedCommand types, dangerous pattern
  detection, opaque construct detection)
- `assistant/src/permissions/command-registry.ts` → `gateway/src/risk/command-registry.ts`
  (DEFAULT_COMMAND_REGISTRY, ~1000 lines)
- `assistant/src/permissions/risk-types.ts` → split:
  - Registry types (`CommandRiskSpec`, `ArgRule`, `ArgSchema`, `RegistryRisk`,
    etc.) → `gateway/src/risk/risk-types.ts`
  - Wire types (`RiskAssessment`, `ScopeOption`) → shared (exported from
    gateway, imported by assistant) or duplicated as IPC response types
  - Classifier-internal types (`Risk`, `BashClassifierInput`, `RiskClassifier`)
    → `gateway/src/risk/risk-types.ts`
- `assistant/src/permissions/bash-risk-classifier.ts` →
  `gateway/src/risk/bash-risk-classifier.ts` (~900 lines)
- `assistant/src/permissions/arg-parser.ts` → `gateway/src/risk/arg-parser.ts`
- `assistant/src/permissions/shell-identity.ts` (scope option generation parts)
  → `gateway/src/risk/scope-options.ts`

**What stays in `assistant/`:**
- `checker.ts` — refactored to call `ipcClassifyRisk()` instead of local
  `classifyRisk()`. No fallback — gateway is a hard dependency.
- `approval-policy.ts` — unchanged, consumes RiskAssessment
- `trust-store.ts` — v1 trust rules, unchanged (legacy fallback)
- `types.ts` — `RiskLevel`, `AllowlistOption`, `PermissionCheckResult`, etc.

**New gateway code:**
- `gateway/src/risk/` directory with all moved files
- `gateway/src/ipc/risk-classification-handlers.ts` — IPC route for
  `classify_risk`
- Persistent IPC connection variant in `assistant/src/ipc/gateway-client.ts`
  (or upgrade existing one-shot to support keepalive)

**New assistant code:**
- `assistant/src/ipc/gateway-client.ts` — add `ipcClassifyRisk()` typed helper
- `assistant/src/permissions/checker.ts` — refactor `classifyRisk()` to call
  gateway IPC (no fallback — gateway is a hard dependency)

**Dependencies:**
- Gateway gains: `web-tree-sitter`, `tree-sitter-bash` (WASM packages)
- Types shared via IPC response schema (Zod validation on both sides)

**Exit criteria:**
- `classify_risk` IPC method returns correct RiskAssessment for bash commands
- Assistant's permission checker uses gateway classification (no fallback)
- All existing permission tests pass (behavior unchanged)
- Both v1 and v3 permission paths use the gateway classifier

---

### Phase 2: Trust Rules V3 Table & Seeding

**Goal:** Create the `trust_rules` SQLite table, seed it with default
registry entries on startup, and expose CRUD routes.

**Gateway work:**
- Add `trustRules` table to `gateway/src/db/schema.ts`
- Create `gateway/src/db/trust-rules-v3-store.ts` — Drizzle CRUD operations
- Create seeding function: transform `DEFAULT_COMMAND_REGISTRY` entries into
  table rows, run upsert on every gateway startup (three-guard logic from §5.1)
- Wire seeding into `initGatewayDb()` after schema push
- HTTP routes: `GET /manage`, `PATCH /manage/:id`, `DELETE /manage/:id`,
  `POST /manage`
- Wire CRUD into gateway router (behind `permission-controls-v3` flag for write
  operations; reads are unflagged since the classifier needs them)

**Classifier integration:**
- Refactor `bash-risk-classifier.ts` (now in gateway) to load base risk from
  trust_rules in-memory cache instead of the in-code `DEFAULT_COMMAND_REGISTRY`
  object
- Arg rules stay in code — applied after base risk lookup
- Cache refreshes on trust rule changes (CRUD operations trigger invalidation)
- `matchType: "user_rule"` when the winning rule has `user_modified = 1` or
  `origin = 'user_defined'`

**Exit criteria:**
- Table created, seeded with ~290 default entries on startup
- CRUD routes work (list, update risk, delete/soft-delete)
- Classifier reads base risk from table (not in-code registry)
- User-modified and soft-deleted rules survive restart
- Registry upsert respects three guards

---

### Phase 3: Wire Rule Creation from Permission Prompt

**Goal:** Update the V3 Rule Editor Modal's save path to write to the new
`trust_rules` table instead of the v1 trust store.

**Changes:**
- Update `V3RuleEditorModal.swift` — save handler calls new `POST /manage`
  endpoint with `origin = 'user_defined'`
- Update gateway POST handler to accept the rule and insert into
  `trust_rules`
- Invalidate classifier cache on new rule insertion

**Exit criteria:**
- Rules created via "Create a rule" from the permission prompt flow persist
  to trust_rules
- Classifier picks up new rules immediately (cache invalidation)

---

### Phase 4: V3 Trust Rules Manager (Client)

**Goal:** Build the Trust Rules Manager UI in the macOS client, accessible from
the Privacy & Permissions settings page.

**New SwiftUI files:**
- `V3TrustRulesView.swift` — list view with risk badges, origin badges,
  user-modified indicators. Default view shows user-origin only, opt-in toggle
  for defaults.
- `V3TrustRuleEditModal.swift` — simplified edit modal: read-only pattern,
  risk picker, "Reset to Default" for modified defaults.

**Wire-in:**
- Update `SettingsPanel.swift` — when `permission-controls-v3` flag is on,
  "Manage Trust Rules" button opens `V3TrustRulesView` instead of
  `TrustRulesView`
- Update `TrustRuleClient.swift` — add v3 endpoint methods (list, update,
  delete) alongside existing v1 methods

**Exit criteria:**
- Trust Rules Manager shows user-created and user-modified rules
- Toggle reveals all default rules
- Edit modal changes risk level and persists via PATCH
- Delete works (soft-delete for defaults, hard-delete for user-defined)
- Rules created in Phase 3 appear in the manager
- Gated behind `permission-controls-v3` flag

---

### Phase 5: Cleanup

**Goal:** Remove dead assistant-side classification code. Since there's no
fallback path, the old code is dead as soon as Phase 1 ships.

**Remove from `assistant/`:**
- `permissions/bash-risk-classifier.ts`
- `permissions/command-registry.ts`
- `permissions/risk-types.ts` (registry-specific types only)
- `permissions/arg-parser.ts`
- Shell parser (`tools/terminal/parser.ts`) — if no other consumers remain
- `permissions/shell-identity.ts` — scope option generation (moved to gateway)
- `web-tree-sitter` and `tree-sitter-bash` from assistant dependencies

**Exit criteria:**
- Assistant has zero in-process classification code
- All classification flows through gateway IPC
- Assistant package is lighter (no WASM dependencies)

## 12. Open Questions

1. **Restore UI for deleted defaults**: Do we show a "Deleted Rules" section or
   a restore option anywhere? Or is soft-delete effectively permanent from the
   user's perspective?

2. **Arg rule visibility**: Should the Trust Rules Manager surface any
   information about arg-level escalation rules (e.g. showing that `rm` is
   medium but `rm -rf` escalates to high)? Or keep arg rules as invisible
   classifier internals?

3. **Persistent IPC connection**: The current `ipcCall()` is one-shot (connect,
   call, disconnect). Classification is hot-path. Phase 1 needs a persistent
   connection variant. Design: connection pool, single keepalive, or upgrade
   existing one-shot? The gateway IPC server already tracks a single
   `this.client` — may need to support multiple concurrent clients or use a
   request multiplexing approach.

4. **Shell parser consumers**: Does anything else in the assistant import from
   `tools/terminal/parser.ts` besides the classifier? If so, those consumers
   need to be refactored to use the gateway IPC or duplicated. Audit as part
   of Phase 1.
