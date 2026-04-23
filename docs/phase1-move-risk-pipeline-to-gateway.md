# Phase 1: Move Risk Classification Pipeline to Gateway

> **Context:** See `docs/v3-trust-rules-design.md` for the full design.
> This is Phase 1 of 5. Each phase maps to one `/create-plan` session.

## Goal

Move the entire risk classification pipeline — shell parser, command registry,
all risk classifiers (bash, file, web, skill, schedule), arg parser, scope
option generation — from the assistant to the gateway. Expose a `classify_risk`
IPC method over the existing Unix domain socket. Refactor the assistant's
`checker.ts` to call the gateway instead of classifying locally.

**No fallback.** The gateway is a hard dependency (same stance as
autoApproveUpTo threshold resolution). If the gateway is down, classification
fails.

**Powers both v1 and v3 permission paths.** One classification call for both.

## What Moves

### Production files (assistant → gateway)

| Source (assistant/) | Destination (gateway/) | Lines | Notes |
|---|---|---|---|
| `tools/terminal/parser.ts` | `src/risk/shell-parser.ts` | 623 | tree-sitter-bash WASM init, ParsedCommand, dangerous patterns, opaque constructs |
| `permissions/command-registry.ts` | `src/risk/command-registry.ts` | 1005 | DEFAULT_COMMAND_REGISTRY (~290 entries) |
| `permissions/risk-types.ts` | `src/risk/risk-types.ts` | 262 | CommandRiskSpec, ArgRule, ArgSchema, RegistryRisk, RiskAssessment, etc. |
| `permissions/bash-risk-classifier.ts` | `src/risk/bash-risk-classifier.ts` | 950 | BashRiskClassifier class |
| `permissions/file-risk-classifier.ts` | `src/risk/file-risk-classifier.ts` | 274 | FileRiskClassifier |
| `permissions/web-risk-classifier.ts` | `src/risk/web-risk-classifier.ts` | 89 | WebRiskClassifier |
| `permissions/skill-risk-classifier.ts` | `src/risk/skill-risk-classifier.ts` | 214 | SkillLoadRiskClassifier |
| `permissions/schedule-risk-classifier.ts` | `src/risk/schedule-risk-classifier.ts` | 85 | ScheduleRiskClassifier |
| `permissions/arg-parser.ts` | `src/risk/arg-parser.ts` | 141 | parseArgs() for arg schema evaluation |
| `permissions/shell-identity.ts` | `src/risk/shell-identity.ts` | 297 | analyzeShellCommand, deriveShellActionKeys, buildShellAllowlistOptions, cachedParse, generateScopeOptions |

**Total: ~3,940 lines of production code moving.**

### Test files (assistant → gateway)

| Source (assistant/) | Destination (gateway/) | Lines |
|---|---|---|
| `permissions/bash-risk-classifier.test.ts` | `src/risk/bash-risk-classifier.test.ts` | 1620 |
| `permissions/command-registry.test.ts` | `src/risk/command-registry.test.ts` | 774 |
| `permissions/arg-parser.test.ts` | `src/risk/arg-parser.test.ts` | 161 |
| `permissions/file-risk-classifier.test.ts` | `src/risk/file-risk-classifier.test.ts` | 535 |
| `permissions/web-risk-classifier.test.ts` | `src/risk/web-risk-classifier.test.ts` | 170 |
| `permissions/skill-risk-classifier.test.ts` | `src/risk/skill-risk-classifier.test.ts` | 311 |
| `permissions/schedule-risk-classifier.test.ts` | `src/risk/schedule-risk-classifier.test.ts` | 129 |
| `__tests__/parser.test.ts` | `src/risk/shell-parser.test.ts` | 595 |
| `__tests__/shell-parser-property.test.ts` | `src/risk/shell-parser-property.test.ts` | 936 |
| `__tests__/shell-parser-fuzz.test.ts` | `src/risk/shell-parser-fuzz.test.ts` | 629 |
| `__tests__/shell-identity.test.ts` | `src/risk/shell-identity.test.ts` | 236 |
| `__tests__/risk-classifier-parity.test.ts` | `src/risk/risk-classifier-parity.test.ts` | 230 |

**Total: ~6,326 lines of test code moving.**

## What Stays in assistant/

- `permissions/checker.ts` — **refactored**: `classifyRisk()` calls gateway
  IPC instead of local classifiers. `generateAllowlistOptions()` also calls
  gateway IPC. Caching stays in checker (keyed on same inputs). The entire
  classifier dispatch (bash/file/web/skill/schedule switch statement), the
  `classifyRiskFromRegistry()` fallback, and the sandboxAutoApprove evaluation
  move to the gateway. checker.ts shrinks dramatically.
- `permissions/approval-policy.ts` — unchanged
- `permissions/trust-store.ts` — v1 trust rules, unchanged
- `permissions/types.ts` — RiskLevel, AllowlistOption, ScopeOption, etc.
  (consumed by many assistant modules)
- `permissions/gateway-threshold-reader.ts` — unchanged
- `permissions/workspace-policy.ts` — unchanged
- `permissions/v2-consent-policy.ts` — unchanged
- `permissions/prompter.ts`, `permissions/secret-prompter.ts` — unchanged
- `permissions/defaults.ts`, `permissions/permission-mode.ts` — unchanged
- `permissions/trust-client.ts`, `permissions/trust-store-interface.ts` — unchanged

## What stays in assistant/ but needs import updates

The `check()` function in `checker.ts` currently calls:
- `cachedParse()` from shell-identity — **moves to gateway** (the gateway
  parses the command as part of classification)
- `analyzeShellCommand()`, `deriveShellActionKeys()` from shell-identity — only
  used for building v1 command candidates. These need to stay temporarily for
  the v1 trust rule matching path in `buildCommandCandidates()`.

**Decision point**: `buildCommandCandidates()` and the v1 trust rule matching
in `check()` still need shell parsing for action key derivation. Two options:

A. **Keep a copy of shell-identity and parser in assistant for v1** — means
   dual WASM, messy. Bad.
B. **Have the gateway return v1-compatible action keys in the classification
   response** — the gateway already parses the command, so it can also return
   the derived action keys. `check()` uses those for v1 trust rule matching
   instead of parsing locally. Clean.

**Go with option B.** Add `actionKeys` and `commandCandidates` to the
`classify_risk` IPC response so the assistant's `check()` function can use
them for v1 trust rule matching without local parsing.

## New Gateway Code

### `gateway/src/risk/` directory

New directory containing all moved files. All imports updated to use relative
paths within the gateway package.

### `gateway/src/ipc/risk-classification-handlers.ts`

New IPC route handler file:

```typescript
import { z } from "zod";
import type { IpcRoute } from "./server.js";

const ClassifyRiskSchema = z.object({
  tool: z.string().min(1),
  command: z.string().optional(),   // bash/host_bash
  url: z.string().optional(),       // web_fetch/network_request/web_search
  path: z.string().optional(),      // file tools
  skill: z.string().optional(),     // skill_load
  mode: z.string().optional(),      // schedule tools
  script: z.string().optional(),    // schedule tools
  workingDir: z.string().optional(),
  allowPrivateNetwork: z.boolean().optional(),
  networkMode: z.string().optional(),   // "proxied" for credential proxy
  isContainerized: z.boolean().optional(),
});

export const riskClassificationRoutes: IpcRoute[] = [
  {
    method: "classify_risk",
    schema: ClassifyRiskSchema,
    handler: async (params) => {
      // 1. Dispatch to appropriate classifier based on tool name
      // 2. Build scope options / allowlist options
      // 3. Build v1-compatible action keys + command candidates
      // 4. Return full ClassificationResult
    },
  },
];
```

**Response shape:**

```typescript
interface ClassificationResult {
  // Risk assessment
  risk: "low" | "medium" | "high" | "unknown";
  reason?: string;

  // Scope ladder options for v3 Rule Editor Modal
  scopeOptions?: ScopeOption[];

  // Allowlist options for v1 permission prompt
  allowlistOptions?: AllowlistOption[];

  // V1-compatible action keys for trust rule matching
  // (so assistant doesn't need to parse locally)
  actionKeys?: string[];
  commandCandidates?: string[];

  // Shell parsing metadata (for UI display)
  dangerousPatterns?: DangerousPattern[];
  opaqueConstructs?: string[];
  isComplexSyntax?: boolean;

  // sandboxAutoApprove — gateway evaluates this since it has the registry,
  // arg parser, and path resolution logic
  sandboxAutoApprove?: boolean;
}
```

### Wire into gateway startup

In `gateway/src/index.ts`, add to the IPC server routes:

```typescript
import { riskClassificationRoutes } from "./ipc/risk-classification-handlers.js";

const ipcServer = new GatewayIpcServer([
  ...featureFlagRoutes,
  ...contactRoutes,
  ...thresholdRoutes,
  ...trustRuleRoutes,
  ...riskClassificationRoutes,  // NEW
]);
```

### Gateway dependency additions

Add to `gateway/package.json`:
- `web-tree-sitter: "0.26.5"`
- `tree-sitter-bash: "0.25.1"`

(Same versions as assistant currently uses.)

## New Assistant Code

### `assistant/src/ipc/gateway-client.ts` — add persistent IPC + typed helper

The current `ipcCall()` is one-shot (connect per call). Classification is
hot-path. Add a persistent connection variant:

```typescript
/**
 * Persistent IPC connection for hot-path gateway calls.
 * Maintains a single Unix socket connection and multiplexes requests.
 */
class PersistentIpcClient {
  private socket: Socket | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 0;
  private buffer = "";

  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    // Connect on first use, reconnect on failure
    // Send request, track by ID, resolve when response arrives
  }
}

// Singleton
let persistentClient: PersistentIpcClient | null = null;

export async function ipcCallPersistent(
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (!persistentClient) persistentClient = new PersistentIpcClient();
  return persistentClient.call(method, params);
}

export async function ipcClassifyRisk(params: {
  tool: string;
  command?: string;
  url?: string;
  path?: string;
  skill?: string;
  mode?: string;
  script?: string;
  workingDir?: string;
  allowPrivateNetwork?: boolean;
  networkMode?: string;
  isContainerized?: boolean;
}): Promise<ClassificationResult | undefined> {
  const result = await ipcCallPersistent("classify_risk", params);
  // validate shape, return typed result or undefined
}
```

### `assistant/src/permissions/checker.ts` — refactor

**classifyRisk()** becomes:

```typescript
export async function classifyRisk(
  toolName: string,
  input: Record<string, unknown>,
  workingDir?: string,
  manifestOverride?: ManifestOverride,
  signal?: AbortSignal,
): Promise<RiskClassification> {
  // Check cache
  // Call ipcClassifyRisk() with tool-appropriate params
  // Map response to RiskClassification
  // Cache and return
}
```

The entire switch statement dispatching to bash/file/web/skill/schedule
classifiers gets replaced with a single IPC call.

**check()** — refactored to use gateway-provided `commandCandidates` and
`sandboxAutoApprove` instead of computing them locally:

```typescript
export async function check(...): Promise<PermissionCheckResult> {
  // Call classifyRisk() (which calls gateway IPC)
  // Use gateway-provided commandCandidates for v1 rule matching
  // Use gateway-provided sandboxAutoApprove
  // Rest of approval policy logic unchanged
}
```

**generateAllowlistOptions()** — uses cached assessment's allowlistOptions
(same as today, but now gateway-provided).

**generateScopeOptions()** — stays in assistant since it's pure computation
off workingDir and doesn't need the registry.

Remove these imports from checker.ts:
- `parseArgs` from `./arg-parser.js`
- `bashRiskClassifier` from `./bash-risk-classifier.js`
- `DEFAULT_COMMAND_REGISTRY` from `./command-registry.js`
- `fileRiskClassifier` from `./file-risk-classifier.js`
- `webRiskClassifier` from `./web-risk-classifier.js`
- `skillLoadRiskClassifier` from `./skill-risk-classifier.js`
- `scheduleRiskClassifier` from `./schedule-risk-classifier.js`
- `type CommandRiskSpec, type RiskAssessment, riskToRiskLevel` from `./risk-types.js`
- `analyzeShellCommand, buildShellAllowlistOptions, cachedParse, deriveShellActionKeys, type ParsedCommand` from `./shell-identity.js`

## PR Strategy

This should be done in 2-3 PRs in sequence:

### PR 1: Copy risk pipeline to gateway + IPC endpoint

- Create `gateway/src/risk/` with all moved files
- Fix all imports to be gateway-relative
- Add `web-tree-sitter` and `tree-sitter-bash` to gateway deps
- Create `gateway/src/ipc/risk-classification-handlers.ts`
- Register routes in `gateway/src/index.ts`
- Add persistent IPC client to `assistant/src/ipc/gateway-client.ts`
- Add `ipcClassifyRisk()` typed helper
- Tests for the IPC handler (can reuse existing test cases)

At this point both paths exist: old (assistant-local) and new (gateway IPC).

### PR 2: Refactor checker.ts to use gateway IPC

- Refactor `classifyRisk()` to call `ipcClassifyRisk()`
- Refactor `check()` to use gateway-provided `commandCandidates` and
  `sandboxAutoApprove`
- Refactor `generateAllowlistOptions()` to use gateway-provided options
- Remove all classifier imports from checker.ts
- Update existing checker tests to mock IPC instead of classifiers

### PR 3: Delete assistant-side classifier code

- Delete the moved files from `assistant/src/permissions/` and
  `assistant/src/tools/terminal/parser.ts`
- Delete moved test files from `assistant/src/__tests__/` and
  `assistant/src/permissions/`
- Remove `web-tree-sitter` and `tree-sitter-bash` from assistant deps
- Verify no broken imports

## Key Risks & Mitigations

1. **WASM loading in gateway**: tree-sitter-bash loads `.wasm` files via
   filesystem paths resolved relative to `node_modules`. Both gateway and
   assistant run on Bun, so the loading mechanism should be identical. The
   existing parser has SHA-256 integrity checks on the WASM files. Test
   early in PR 1 that parsing works in the gateway process.

2. **Persistent IPC connection stability**: The gateway IPC server currently
   tracks a single `this.client`. The persistent connection from the assistant
   needs to handle reconnection gracefully (socket close → reconnect on next
   call). The gateway server already handles client replacement ("New IPC
   client connected, replacing previous connection").

3. **sandboxAutoApprove path resolution**: The gateway needs to know
   `workingDir` and `isContainerized` to evaluate sandboxAutoApprove. These
   are passed as IPC params. The workspace root is resolved via the same
   `getWorkspaceDir()` utility — need to ensure this works in the gateway
   process (it reads from env/config, should be fine).

4. **skill_risk_classifier special case**: The SkillLoadRiskClassifier
   resolves skill selectors and checks for inline command expansions, which
   requires the skill catalog. The skill catalog is loaded from disk in the
   assistant process. Two options:
   - Pass the resolved skill metadata as IPC params (skill ID, version hash,
     hasInlineExpansions, transitiveHash)
   - Keep skill classification in the assistant

   **Recommendation**: Pass metadata as IPC params. The gateway doesn't need
   the full skill catalog — just the pre-resolved data points. This keeps all
   classification in one place.

5. **Test execution**: Gateway tests run via `bun test` in `gateway/`.
   Currently there are no WASM-dependent tests in gateway. Need to ensure
   the test runner can load tree-sitter-bash WASM. May need a test setup
   step similar to what assistant tests do.

## Files to Read

Before starting implementation, read these files to understand the full picture:

- `gateway/src/ipc/server.ts` — IPC server implementation and route registration
- `gateway/src/ipc/threshold-handlers.ts` — Good pattern example for IPC handlers
- `gateway/src/ipc/trust-rule-handlers.ts` — Existing trust rule IPC (v1)
- `gateway/src/index.ts` lines 1900-1910 — Where IPC routes are registered
- `assistant/src/ipc/gateway-client.ts` — Existing IPC client
- `assistant/src/permissions/checker.ts` — The main file being refactored
- `assistant/src/permissions/bash-risk-classifier.ts` — Largest classifier
- `assistant/src/permissions/risk-types.ts` — Shared types
- `assistant/src/permissions/shell-identity.ts` — Action key derivation + scope options
- `assistant/src/tools/terminal/parser.ts` — Shell parser (WASM)
- `assistant/src/permissions/command-registry.ts` — The registry (~290 entries)
