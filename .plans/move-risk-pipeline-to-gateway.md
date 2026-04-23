# Phase 1: Move Risk Classification Pipeline to Gateway

## Overview
Move the entire risk classification pipeline (shell parser, command registry, all classifiers, arg parser, scope option generation) from the assistant to the gateway. Expose a `classify_risk` IPC method over the existing Unix domain socket. Refactor the assistant's `checker.ts` to call the gateway instead of classifying locally. No fallback — the gateway is a hard dependency. See `docs/phase1-move-risk-pipeline-to-gateway.md` and `docs/v3-trust-rules-design.md` for full design context.

## PR 1: Add risk pipeline foundation to gateway
### Depends on
None

### Branch
risk-pipe-gateway/pr-1-foundation

### Title
feat(gateway): add risk type definitions and tree-sitter dependencies

### Files
- `gateway/package.json`
- `gateway/src/risk/risk-types.ts`

### Implementation steps
1. Add `web-tree-sitter` (exact `0.26.5`) and `tree-sitter-bash` (exact `0.25.1`) to `gateway/package.json` dependencies. These are the same versions used in the assistant. Run `cd gateway && bun add --exact web-tree-sitter@0.26.5 tree-sitter-bash@0.25.1`.
2. Create `gateway/src/risk/risk-types.ts` by copying `assistant/src/permissions/risk-types.ts`. This file defines `Risk`, `RegistryRisk`, `CommandRiskSpec`, `ArgRule`, `ArgSchema`, `RiskAssessment`, `ScopeOption`, `AllowlistOption`, `UserRule`, `RiskClassifier`, `DangerousPattern`, `DangerousPatternType`, `BashClassifierInput`, and the `RISK_ORD` / `riskToRiskLevel` helpers. Remove any imports that reference assistant-specific modules — this file should be self-contained (it already is in the assistant; the only import is `RiskLevel` from `./types.js` which can be inlined as a simple enum: `Low = "low"`, `Medium = "medium"`, `High = "high"`). Define a local `RiskLevel` enum or union in risk-types.ts for gateway use.
3. Verify the gateway type-checks: `cd gateway && bunx tsc --noEmit`.

### Acceptance criteria
- `gateway/package.json` includes `web-tree-sitter` and `tree-sitter-bash` at exact pinned versions
- `gateway/src/risk/risk-types.ts` exports all risk classification types with no assistant imports
- `cd gateway && bunx tsc --noEmit` passes

---

## PR 2: Add persistent IPC client to assistant
### Depends on
None

### Branch
risk-pipe-gateway/pr-2-persistent-ipc

### Title
feat(assistant): add persistent IPC connection for hot-path gateway calls

### Files
- `assistant/src/ipc/gateway-client.ts`
- `assistant/src/ipc/gateway-client.test.ts`

### Implementation steps
1. In `assistant/src/ipc/gateway-client.ts`, add a `PersistentIpcClient` class below the existing `ipcCall()` function. The class maintains a single Unix socket connection to the gateway, with automatic reconnection on failure. Key design:
   - Private fields: `socket: Socket | null`, `pending: Map<string, { resolve, reject, timer }>`, `nextId: number`, `buffer: string`, `connecting: Promise<void> | null`
   - `async call(method: string, params?: Record<string, unknown>): Promise<unknown>` — connects on first use, sends `{ id, method, params }\n`, tracks pending request by ID, resolves when response arrives. Timeout of 5s per call (configurable). On socket error/close, rejects all pending requests and nullifies socket so next call reconnects.
   - Handle newline-delimited JSON responses, matching `id` to pending requests.
   - `unref()` the socket so it doesn't prevent process exit.
   - `destroy()` method to explicitly close the connection.
2. Export `ipcCallPersistent(method, params)` — singleton wrapper around `PersistentIpcClient`. Creates the instance on first call using `getGatewaySocketPath()`.
3. Add a `resetPersistentClient()` export for testing (destroys and nullifies the singleton).
4. Create `assistant/src/ipc/gateway-client.test.ts` with unit tests:
   - Test that `ipcCallPersistent` connects and sends correctly formatted JSON
   - Test that responses are routed to the correct pending request by ID
   - Test reconnection after socket close
   - Test timeout handling (pending request rejects after timeout)
   - Use a mock Unix socket server in tests

### Acceptance criteria
- `PersistentIpcClient` maintains a single connection and multiplexes requests by ID
- Automatic reconnection on socket failure (next `call()` re-establishes)
- Timeout handling rejects pending requests gracefully
- `cd assistant && bun test src/ipc/gateway-client.test.ts` passes

---

## PR 3: Copy shell parser to gateway
### Depends on
PR 1

### Branch
risk-pipe-gateway/pr-3-shell-parser

### Title
feat(gateway): add tree-sitter-bash shell parser for risk classification

### Files
- `gateway/src/risk/shell-parser.ts`
- `gateway/src/risk/shell-parser.test.ts`
- `gateway/src/risk/shell-parser-property.test.ts`
- `gateway/src/risk/shell-parser-fuzz.test.ts`

### Implementation steps
1. Create `gateway/src/risk/shell-parser.ts` by copying `assistant/src/tools/terminal/parser.ts`. Update internal imports:
   - Remove any assistant-specific imports (there should be none — the parser is self-contained with only `web-tree-sitter` and `tree-sitter-bash` as external deps)
   - The `DangerousPattern` / `DangerousPatternType` types may be imported from `./risk-types.js` if they were placed there in PR 1, or kept inline in the parser file (they are defined in parser.ts in the assistant)
   - Ensure `ParsedCommand`, `CommandSegment`, `parse()`, `ensureParser()` are exported
2. Verify WASM file resolution works in the gateway context. The parser's `locateWasmFile()` resolves WASM binaries relative to `node_modules`. In the gateway dev environment (not compiled), this should work via `require.resolve()` / `import.meta.resolve()`. Add a test that calls `parse("echo hello")` to confirm WASM loads correctly.
3. Copy `assistant/src/__tests__/parser.test.ts` → `gateway/src/risk/shell-parser.test.ts`. Update the import to `import { parse } from "./shell-parser.js"`. Run and verify tests pass.
4. Copy `assistant/src/__tests__/shell-parser-property.test.ts` → `gateway/src/risk/shell-parser-property.test.ts`. Update imports.
5. Copy `assistant/src/__tests__/shell-parser-fuzz.test.ts` → `gateway/src/risk/shell-parser-fuzz.test.ts`. Update imports.
6. Verify: `cd gateway && bun test src/risk/shell-parser.test.ts src/risk/shell-parser-property.test.ts src/risk/shell-parser-fuzz.test.ts`.

### Acceptance criteria
- `parse()` in gateway context correctly parses bash commands via tree-sitter WASM
- All parser tests pass in gateway test runner (WASM loading verified)
- Dangerous pattern detection and opaque construct detection work identically
- `cd gateway && bunx tsc --noEmit` passes

---

## PR 4: Copy arg parser and command registry to gateway
### Depends on
PR 1

### Branch
risk-pipe-gateway/pr-4-arg-parser-registry

### Title
feat(gateway): add arg parser and command registry for risk classification

### Files
- `gateway/src/risk/arg-parser.ts`
- `gateway/src/risk/arg-parser.test.ts`
- `gateway/src/risk/command-registry.ts`
- `gateway/src/risk/command-registry.test.ts`

### Implementation steps
1. Create `gateway/src/risk/arg-parser.ts` by copying `assistant/src/permissions/arg-parser.ts`. Update the import of `ArgSchema` / `PositionalDesc` / `ParsedArgs` types to reference `./risk-types.js`. Export `parseArgs()` and the `ParsedArgs` type.
2. Create `gateway/src/risk/command-registry.ts` by copying `assistant/src/permissions/command-registry.ts`. Update the import of `CommandRiskSpec` to reference `./risk-types.js`. Export `DEFAULT_COMMAND_REGISTRY`.
3. Copy `assistant/src/permissions/arg-parser.test.ts` → `gateway/src/risk/arg-parser.test.ts`. Update imports to `./arg-parser.js` and `./risk-types.js`.
4. Copy `assistant/src/permissions/command-registry.test.ts` → `gateway/src/risk/command-registry.test.ts`. Update imports to `./command-registry.js` and `./risk-types.js`.
5. Verify: `cd gateway && bun test src/risk/arg-parser.test.ts src/risk/command-registry.test.ts`.

### Acceptance criteria
- `parseArgs()` works identically in gateway context
- `DEFAULT_COMMAND_REGISTRY` is accessible and correctly typed
- All arg parser and command registry tests pass
- `cd gateway && bunx tsc --noEmit` passes

---

## PR 5: Copy non-bash classifiers to gateway
### Depends on
PR 1

### Branch
risk-pipe-gateway/pr-5-non-bash-classifiers

### Title
feat(gateway): add file, web, skill, and schedule risk classifiers

### Files
- `gateway/src/risk/file-risk-classifier.ts`
- `gateway/src/risk/file-risk-classifier.test.ts`
- `gateway/src/risk/web-risk-classifier.ts`
- `gateway/src/risk/web-risk-classifier.test.ts`
- `gateway/src/risk/skill-risk-classifier.ts`
- `gateway/src/risk/skill-risk-classifier.test.ts`
- `gateway/src/risk/schedule-risk-classifier.ts`
- `gateway/src/risk/schedule-risk-classifier.test.ts`

### Implementation steps
1. **WebRiskClassifier** — Create `gateway/src/risk/web-risk-classifier.ts` by copying `assistant/src/permissions/web-risk-classifier.ts`. This classifier is pure logic with no assistant-specific imports (only risk-types). Update imports to `./risk-types.js`. Copy tests, update imports.
2. **ScheduleRiskClassifier** — Create `gateway/src/risk/schedule-risk-classifier.ts` by copying `assistant/src/permissions/schedule-risk-classifier.ts`. Also pure logic. Update imports to `./risk-types.js`. Copy tests.
3. **FileRiskClassifier** — Create `gateway/src/risk/file-risk-classifier.ts` by copying `assistant/src/permissions/file-risk-classifier.ts`. This classifier currently imports from `path-classifier.js` (`isSkillSourcePath`), `platform.js` (`getActorTokenSigningKeyPath`, `getProtectedDir`, `isHooksPath`), and `config/loader.js`. **Refactor the classifier to accept context as constructor/method parameters** instead of importing assistant modules:
   - Add a `FileClassificationContext` interface: `{ protectedDir: string; hooksDir: string; actorTokenSigningKeyPath: string; skillSourceDirs: string[] }`.
   - The `classify()` method accepts this context as an additional parameter (or the classifier is constructed with it).
   - Replace `getProtectedDir()` calls with `context.protectedDir`, `isHooksPath(p)` with a local check against `context.hooksDir`, `getActorTokenSigningKeyPath()` with `context.actorTokenSigningKeyPath`, and `isSkillSourcePath(p)` with checking against `context.skillSourceDirs`.
   - This keeps the classifier testable and decoupled from the assistant's module system.
   - Copy tests, adapting them to pass the context in test setup.
4. **SkillLoadRiskClassifier** — Create `gateway/src/risk/skill-risk-classifier.ts` by copying `assistant/src/permissions/skill-risk-classifier.ts`. This classifier currently imports skill catalog utilities, feature flags, and version hashing from the assistant. **Refactor to accept pre-resolved skill metadata as classify() parameters** instead of resolving internally:
   - Add a `SkillClassificationInput` interface extending the base input: `{ tool: string; skill?: string; resolvedMetadata?: { skillId: string; selector: string; versionHash: string; transitiveHash?: string; hasInlineExpansions: boolean; isDynamic: boolean } }`.
   - The `classify()` method uses `resolvedMetadata` directly instead of loading the skill catalog. If `resolvedMetadata` is absent, the classifier returns a basic medium-risk assessment (the assistant is responsible for resolving metadata before calling IPC).
   - The allowlist option generation uses the pre-resolved metadata fields to build pinned/unpinned options.
   - This eliminates all assistant-specific imports (config, skills, feature flags).
   - Copy tests, providing mock `resolvedMetadata` in test setup.
5. Verify all tests: `cd gateway && bun test src/risk/file-risk-classifier.test.ts src/risk/web-risk-classifier.test.ts src/risk/skill-risk-classifier.test.ts src/risk/schedule-risk-classifier.test.ts`.

### Acceptance criteria
- All four classifiers work in the gateway with no assistant-specific imports
- FileRiskClassifier accepts context params instead of importing assistant platform utils
- SkillLoadRiskClassifier accepts pre-resolved metadata instead of loading skill catalog
- WebRiskClassifier and ScheduleRiskClassifier are direct copies with updated imports
- All classifier tests pass in gateway
- `cd gateway && bunx tsc --noEmit` passes

---

## PR 6: Copy bash risk classifier and shell identity to gateway
### Depends on
PR 3, PR 4

### Branch
risk-pipe-gateway/pr-6-bash-classifier

### Title
feat(gateway): add bash risk classifier and shell identity analysis

### Files
- `gateway/src/risk/shell-identity.ts`
- `gateway/src/risk/shell-identity.test.ts`
- `gateway/src/risk/bash-risk-classifier.ts`
- `gateway/src/risk/bash-risk-classifier.test.ts`
- `gateway/src/risk/risk-classifier-parity.test.ts`

### Implementation steps
1. Create `gateway/src/risk/shell-identity.ts` by copying `assistant/src/permissions/shell-identity.ts`. Update imports:
   - `parse`, `ParsedCommand`, `CommandSegment` from `./shell-parser.js` (was `../tools/terminal/parser.js`)
   - `ScopeOption`, `AllowlistOption` from `./risk-types.js` (was `./risk-types.js` — same name, but verify path)
   - Export `cachedParse`, `analyzeShellCommand`, `deriveShellActionKeys`, `buildShellAllowlistOptions`, `generateScopeOptions`, and the `ShellIdentityAnalysis` type.
2. Create `gateway/src/risk/bash-risk-classifier.ts` by copying `assistant/src/permissions/bash-risk-classifier.ts`. Update imports:
   - `parse`, `ParsedCommand`, `CommandSegment`, `DangerousPattern` from `./shell-parser.js`
   - `DEFAULT_COMMAND_REGISTRY` from `./command-registry.js`
   - `parseArgs` from `./arg-parser.js`
   - `cachedParse` from `./shell-identity.js`
   - All risk types from `./risk-types.js`
   - Remove the import of `getWorkspaceDir` from assistant platform.ts — add `workspaceDir` as a parameter to `classify()` (it's already passed as part of `BashClassifierInput`, just ensure the classifier uses the input param instead of calling a global function). Note: `getWorkspaceDir()` in the gateway context resolves from env/config the same way, but to keep the classifier a pure function, accept it as input.
   - Check if `isRmOfKnownSafeFile()` from checker.ts is used in the classifier. If so, it needs to move here too (it checks for rm of lockfiles etc.)
   - Export `bashRiskClassifier` singleton and `BashRiskClassifier` class.
3. Copy `assistant/src/__tests__/shell-identity.test.ts` → `gateway/src/risk/shell-identity.test.ts`. Update imports.
4. Copy `assistant/src/permissions/bash-risk-classifier.test.ts` → `gateway/src/risk/bash-risk-classifier.test.ts`. Update imports.
5. Copy `assistant/src/__tests__/risk-classifier-parity.test.ts` → `gateway/src/risk/risk-classifier-parity.test.ts`. Update imports.
6. Verify: `cd gateway && bun test src/risk/shell-identity.test.ts src/risk/bash-risk-classifier.test.ts src/risk/risk-classifier-parity.test.ts`.

### Acceptance criteria
- Bash risk classifier works in gateway with all deps wired correctly
- Shell identity analysis (action keys, allowlist options, scope options) works identically
- All bash classifier, shell identity, and parity tests pass
- `cd gateway && bunx tsc --noEmit` passes

---

## PR 7: Create classify_risk IPC handler and wire into gateway startup
### Depends on
PR 5, PR 6

### Branch
risk-pipe-gateway/pr-7-ipc-handler

### Title
feat(gateway): expose classify_risk IPC method for risk classification

### Files
- `gateway/src/ipc/risk-classification-handlers.ts`
- `gateway/src/ipc/risk-classification-handlers.test.ts`
- `gateway/src/index.ts`

### Implementation steps
1. Create `gateway/src/ipc/risk-classification-handlers.ts` with a `riskClassificationRoutes: IpcRoute[]` export. Follow the same pattern as `threshold-handlers.ts`:
   - Define `ClassifyRiskSchema` using Zod:
     ```typescript
     const ClassifyRiskSchema = z.object({
       tool: z.string().min(1),
       command: z.string().optional(),
       url: z.string().optional(),
       path: z.string().optional(),
       skill: z.string().optional(),
       mode: z.string().optional(),
       script: z.string().optional(),
       workingDir: z.string().optional(),
       allowPrivateNetwork: z.boolean().optional(),
       networkMode: z.string().optional(),
       isContainerized: z.boolean().optional(),
       // File classifier context (pre-resolved by assistant)
       fileContext: z.object({
         protectedDir: z.string(),
         hooksDir: z.string(),
         actorTokenSigningKeyPath: z.string(),
         skillSourceDirs: z.array(z.string()),
       }).optional(),
       // Skill classifier context (pre-resolved by assistant)
       skillMetadata: z.object({
         skillId: z.string(),
         selector: z.string(),
         versionHash: z.string(),
         transitiveHash: z.string().optional(),
         hasInlineExpansions: z.boolean(),
         isDynamic: z.boolean(),
       }).optional(),
     });
     ```
   - Define the `classify_risk` handler that:
     a. Dispatches to the appropriate classifier based on `tool` name (same switch logic as `checker.ts`'s `classifyRisk()`):
        - `bash` / `host_bash` → `bashRiskClassifier.classify()`
        - `file_read` / `file_write` / `file_edit` / `host_file_read` / `host_file_write` / `host_file_edit` → `fileRiskClassifier.classify()`
        - `web_fetch` / `network_request` / `web_search` → `webRiskClassifier.classify()`
        - `skill_load` / `scaffold_managed_skill` / `delete_managed_skill` → `skillLoadRiskClassifier.classify()`
        - `schedule_create` / `schedule_update` → `scheduleRiskClassifier.classify()`
        - All others → fall back to registry lookup at base risk
     b. For bash/host_bash, also computes:
        - `actionKeys` via `deriveShellActionKeys()` — v1-compatible action keys for trust rule matching
        - `commandCandidates` from the action keys — formatted as `action:<key>` strings
        - `sandboxAutoApprove` — evaluates whether the command qualifies for sandbox auto-approval (no opaque constructs, no dangerous patterns, all segments allowlisted, paths resolve within workspace for non-containerized)
     c. Returns a `ClassificationResult` object with: `risk`, `reason`, `scopeOptions`, `allowlistOptions`, `actionKeys`, `commandCandidates`, `dangerousPatterns`, `opaqueConstructs`, `isComplexSyntax`, `sandboxAutoApprove`, `matchType`.
2. In `gateway/src/index.ts`, import `riskClassificationRoutes` from `./ipc/risk-classification-handlers.js` and spread into the `GatewayIpcServer` constructor's route array alongside existing routes (feature flags, contacts, thresholds).
3. Create `gateway/src/ipc/risk-classification-handlers.test.ts` with integration tests:
   - Test bash command classification: `git push --force` → high risk
   - Test bash scope options: verify scope ladder has correct patterns
   - Test action key derivation: `gh pr view 123` → `["action:gh pr view", "action:gh pr", "action:gh"]`
   - Test sandboxAutoApprove: `ls` → true, `rm -rf /` → false
   - Test file classification with context params
   - Test web classification: `web_search` → low, `web_fetch` with `allowPrivateNetwork` → high
   - Test schedule classification: script mode → high
   - Test unknown tool → fallback risk
4. Verify: `cd gateway && bun test src/ipc/risk-classification-handlers.test.ts`.

### Acceptance criteria
- `classify_risk` IPC method dispatches to all classifier types correctly
- Returns complete `ClassificationResult` with risk, scopeOptions, allowlistOptions, actionKeys, commandCandidates, sandboxAutoApprove
- Bash commands produce v1-compatible action keys and command candidates
- Route is registered in gateway startup
- All integration tests pass
- `cd gateway && bunx tsc --noEmit` passes

---

## PR 8: Add ipcClassifyRisk typed helper to assistant
### Depends on
PR 2

### Branch
risk-pipe-gateway/pr-8-classify-risk-helper

### Title
feat(assistant): add ipcClassifyRisk typed helper for gateway classification

### Files
- `assistant/src/ipc/gateway-client.ts`
- `assistant/src/permissions/ipc-risk-types.ts`

### Implementation steps
1. Create `assistant/src/permissions/ipc-risk-types.ts` with the `ClassificationResult` response type that mirrors the gateway's response shape:
   ```typescript
   export interface ClassificationResult {
     risk: "low" | "medium" | "high" | "unknown";
     reason?: string;
     matchType?: "user_rule" | "registry" | "unknown";
     scopeOptions?: ScopeOption[];
     allowlistOptions?: AllowlistOption[];
     actionKeys?: string[];
     commandCandidates?: string[];
     dangerousPatterns?: DangerousPattern[];
     opaqueConstructs?: string[];
     isComplexSyntax?: boolean;
     sandboxAutoApprove?: boolean;
   }
   ```
   Import `ScopeOption`, `AllowlistOption` from `./types.js` and `DangerousPattern` from `./risk-types.js` (these types stay in the assistant). Also define `ClassifyRiskParams` with all the IPC request fields (`tool`, `command`, `url`, `path`, `skill`, `mode`, `script`, `workingDir`, `allowPrivateNetwork`, `networkMode`, `isContainerized`, `fileContext`, `skillMetadata`).
2. In `assistant/src/ipc/gateway-client.ts`, add `ipcClassifyRisk(params: ClassifyRiskParams): Promise<ClassificationResult | undefined>`:
   - Calls `ipcCallPersistent("classify_risk", params)` (uses the persistent connection from PR 2)
   - Validates the response shape (check for `risk` field at minimum)
   - Returns typed `ClassificationResult` or `undefined` on failure
   - Logs warnings on malformed responses

### Acceptance criteria
- `ipcClassifyRisk()` sends correctly shaped IPC request and returns typed response
- Uses persistent connection (not one-shot) for hot-path performance
- Response validation catches malformed gateway responses
- Type definitions match gateway response shape exactly

---

## PR 9: Refactor checker.ts to call gateway IPC
### Depends on
PR 7, PR 8

### Branch
risk-pipe-gateway/pr-9-refactor-checker

### Title
refactor(assistant): replace local risk classification with gateway IPC

### Files
- `assistant/src/permissions/checker.ts`
- `assistant/src/permissions/checker.test.ts`

### Implementation steps
1. In `assistant/src/permissions/checker.ts`, refactor `classifyRisk()`:
   - Remove the entire classifier dispatch switch statement (bash/file/web/skill/schedule cases)
   - Remove the `classifyRiskFromRegistry()` fallback function
   - Replace with a single call to `ipcClassifyRisk()` from `../ipc/gateway-client.js`:
     - Build the IPC params from the tool name and input:
       - For bash: `{ tool, command: input.command, workingDir, isContainerized: ... }`
       - For file tools: `{ tool, path: input.file_path, fileContext: { protectedDir, hooksDir, actorTokenSigningKeyPath, skillSourceDirs } }` — resolve the file context from assistant platform utils before sending
       - For web tools: `{ tool, url: input.url, allowPrivateNetwork: input.allow_private_network, networkMode: ... }`
       - For skill tools: `{ tool, skill: input.skill, skillMetadata: resolveSkillMetadata(...) }` — resolve skill metadata from the skill catalog before sending
       - For schedule tools: `{ tool, mode: input.mode, script: input.script }`
       - For unknown tools: `{ tool }`
     - Map the `ClassificationResult` response to the existing `RiskClassification` type that `check()` expects
     - If `ipcClassifyRisk()` returns `undefined` (gateway down), throw an error (no fallback, per design)
   - Caching stays in checker.ts — the cache key and invalidation logic are unchanged
   - The proxied bash risk cap (`networkMode === "proxied"` caps High → Medium) should move to the gateway's classify_risk handler since it's classification logic, not policy. Pass `networkMode` in the IPC params (already in the schema).
2. Refactor `check()` to use gateway-provided data instead of computing locally:
   - **commandCandidates**: Use `classification.commandCandidates` from the gateway response instead of calling `buildCommandCandidates()` for bash tools. For other tools, keep the existing candidate building logic (file paths, URLs, skill selectors) since those are derived from assistant-local data.
   - **sandboxAutoApprove**: Use `classification.sandboxAutoApprove` from the gateway response instead of evaluating `hasSandboxAutoApprove` locally. Remove the local sandbox evaluation block.
   - **actionKeys**: Use `classification.actionKeys` for v1 trust rule matching in `buildCommandCandidates()` instead of calling `deriveShellActionKeys()` locally.
3. Remove the `buildCommandCandidates()` function's bash-specific logic that calls `cachedParse()`, `analyzeShellCommand()`, and `deriveShellActionKeys()`. Replace with using `classification.actionKeys` and `classification.commandCandidates` directly from the gateway response.
4. Remove these imports from checker.ts:
   - `parseArgs` from `./arg-parser.js`
   - `bashRiskClassifier` from `./bash-risk-classifier.js`
   - `DEFAULT_COMMAND_REGISTRY` from `./command-registry.js`
   - `fileRiskClassifier` from `./file-risk-classifier.js`
   - `webRiskClassifier` from `./web-risk-classifier.js`
   - `skillLoadRiskClassifier` from `./skill-risk-classifier.js`
   - `scheduleRiskClassifier` from `./schedule-risk-classifier.js`
   - `type CommandRiskSpec`, `type RiskAssessment`, `riskToRiskLevel` from `./risk-types.js` (only if no longer used after refactor)
   - `analyzeShellCommand`, `buildShellAllowlistOptions`, `cachedParse`, `deriveShellActionKeys`, `type ParsedCommand` from `./shell-identity.js`
5. Keep `generateScopeOptions()` in checker.ts — it generates directory-level scope options from `workingDir` and doesn't need the registry.
6. Update `generateAllowlistOptions()` to use the cached assessment's `allowlistOptions` from the gateway response.
7. Update `assistant/src/permissions/checker.test.ts`:
   - Mock `ipcClassifyRisk` from `../ipc/gateway-client.js` instead of individual classifiers
   - Each test case should mock the IPC response to return the expected `ClassificationResult`
   - Verify that `check()` correctly maps gateway responses to `PermissionCheckResult`
   - Verify that `classifyRisk()` correctly calls IPC with the right params for each tool type
   - Verify error behavior when gateway is down (ipcClassifyRisk returns undefined)
8. Verify: `cd assistant && bun test src/permissions/checker.test.ts`.

### Acceptance criteria
- `classifyRisk()` calls gateway IPC instead of local classifiers — no local classification code remains
- `check()` uses gateway-provided `commandCandidates`, `actionKeys`, and `sandboxAutoApprove`
- No fallback — gateway failure throws an error
- All existing permission semantics are preserved (same risk levels, same approval decisions)
- Checker tests pass with mocked IPC responses
- No broken imports — checker.ts no longer imports any classifier modules
- `cd assistant && bunx tsc --noEmit` passes

---

## PR 10: Delete assistant-side classifier code
### Depends on
PR 9

### Branch
risk-pipe-gateway/pr-10-delete-assistant-classifiers

### Title
chore(assistant): remove migrated risk classification code

### Files
- `assistant/src/permissions/bash-risk-classifier.ts` (delete)
- `assistant/src/permissions/bash-risk-classifier.test.ts` (delete)
- `assistant/src/permissions/command-registry.ts` (delete)
- `assistant/src/permissions/command-registry.test.ts` (delete)
- `assistant/src/permissions/arg-parser.ts` (delete)
- `assistant/src/permissions/arg-parser.test.ts` (delete)
- `assistant/src/permissions/file-risk-classifier.ts` (delete)
- `assistant/src/permissions/file-risk-classifier.test.ts` (delete)
- `assistant/src/permissions/web-risk-classifier.ts` (delete)
- `assistant/src/permissions/web-risk-classifier.test.ts` (delete)
- `assistant/src/permissions/skill-risk-classifier.ts` (delete)
- `assistant/src/permissions/skill-risk-classifier.test.ts` (delete)
- `assistant/src/permissions/schedule-risk-classifier.ts` (delete)
- `assistant/src/permissions/schedule-risk-classifier.test.ts` (delete)
- `assistant/src/permissions/shell-identity.ts` (delete)
- `assistant/src/permissions/risk-types.ts` (delete or trim)
- `assistant/src/tools/terminal/parser.ts` (delete)
- `assistant/src/__tests__/parser.test.ts` (delete)
- `assistant/src/__tests__/shell-parser-property.test.ts` (delete)
- `assistant/src/__tests__/shell-parser-fuzz.test.ts` (delete)
- `assistant/src/__tests__/shell-identity.test.ts` (delete)
- `assistant/src/__tests__/risk-classifier-parity.test.ts` (delete)
- `assistant/src/__tests__/terminal-tools.test.ts` (modify — remove parser test section)
- `assistant/package.json`

### Implementation steps
1. Delete all classifier files from `assistant/src/permissions/`:
   - `bash-risk-classifier.ts` + `bash-risk-classifier.test.ts`
   - `command-registry.ts` + `command-registry.test.ts`
   - `arg-parser.ts` + `arg-parser.test.ts`
   - `file-risk-classifier.ts` + `file-risk-classifier.test.ts`
   - `web-risk-classifier.ts` + `web-risk-classifier.test.ts`
   - `skill-risk-classifier.ts` + `skill-risk-classifier.test.ts`
   - `schedule-risk-classifier.ts` + `schedule-risk-classifier.test.ts`
   - `shell-identity.ts`
2. Trim `assistant/src/permissions/risk-types.ts`: remove classifier-internal types (`CommandRiskSpec`, `ArgRule`, `ArgSchema`, `BashClassifierInput`, `RiskClassifier`, etc.) that are no longer used in the assistant. Keep only types still imported by other assistant modules (check imports first). If nothing remains, delete the file entirely.
3. Delete `assistant/src/tools/terminal/parser.ts` — the WASM shell parser now lives in the gateway.
4. Delete all moved test files from `assistant/src/__tests__/`:
   - `parser.test.ts`
   - `shell-parser-property.test.ts`
   - `shell-parser-fuzz.test.ts`
   - `shell-identity.test.ts`
   - `risk-classifier-parity.test.ts`
5. In `assistant/src/__tests__/terminal-tools.test.ts`, remove the "Shell Parser — parse()" test section (section 1) that imports from `tools/terminal/parser.ts`. Keep all other sections of the test (sandbox wrapping, env vars, etc.) intact. Remove the `parse` import.
6. Remove `web-tree-sitter` and `tree-sitter-bash` from `assistant/package.json` dependencies: `cd assistant && bun remove web-tree-sitter tree-sitter-bash`.
7. Run a full import verification: `cd assistant && bunx tsc --noEmit` to catch any dangling imports.
8. Grep for any remaining references to deleted modules: search for imports of `bash-risk-classifier`, `command-registry`, `arg-parser`, `file-risk-classifier`, `web-risk-classifier`, `skill-risk-classifier`, `schedule-risk-classifier`, `shell-identity`, `tools/terminal/parser` across the assistant codebase. Fix any remaining references. NOTE: `tool-executor-shell-integration.test.ts` also imports `parse` from `tools/terminal/parser.ts` — that import needs to be removed or the test refactored.
9. Verify terminal-tools tests still pass: `cd assistant && bun test src/__tests__/terminal-tools.test.ts`.

### Acceptance criteria
- All migrated classifier files deleted from assistant
- Shell parser (WASM) deleted from assistant
- All migrated test files deleted from assistant
- `web-tree-sitter` and `tree-sitter-bash` removed from assistant dependencies
- `terminal-tools.test.ts` still passes (parser section removed, other sections intact)
- No dangling imports — `cd assistant && bunx tsc --noEmit` passes
- Assistant package is lighter (no WASM dependencies)
