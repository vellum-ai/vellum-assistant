# Dead Code Inventory

Generated: 2026-02-15
Tool: knip v5.83.1 (via `bunx knip-bun`)

---

## Assistant Package

### Unused Files

| File | Confidence | Category | Notes |
|------|-----------|----------|-------|
| `src/instrument.ts` | **Safe delete now** | Sentry instrumentation stub | Not imported anywhere |
| `src/config/skill-env.ts` | **Safe delete now** | Skill env helpers | Exports `applySkillEnv`/`restoreSkillEnv`, nothing imports them |
| `src/tools/computer-use/types.ts` | **Safe delete now** | Shared CU input types | Not imported; CU tools define types locally |
| `src/tools/browser/__tests__/auth-cache.test.ts` | **Skip for now** | Test file | Tests for browser auth-cache; test-only, excluded from knip scope |
| `src/tools/browser/__tests__/auth-detector.test.ts` | **Skip for now** | Test file | Same — test-only |
| `src/tools/browser/__tests__/jit-auth.test.ts` | **Skip for now** | Test file | Same — test-only |
| `src/daemon/main.ts` | **False positive** | Daemon entry | Dynamically spawned via `bun --watch` from `index.ts:179` |
| `src/events/index.ts` | **False positive** | Barrel export | Re-exports used types; consumers import submodules directly |
| `src/swarm/index.ts` | **False positive** | Barrel export | Imported by test files |
| `src/usage/summary.ts` | **Likely dead; needs runtime check** | Usage summary | Only imported by its own test file; no production consumer |

### Unused Dependencies

| Dependency | Confidence | Notes |
|-----------|-----------|-------|
| `tree-sitter-bash` | **False positive** | Required at runtime by web-tree-sitter WASM loader |
| `fast-check` (dev) | **False positive** | Used in test files (excluded from knip scope) |
| `quicktype-core` (dev) | **False positive** | Used in IPC codegen scripts |

### Unused Exports (170 total — categorized)

#### Safe delete now (clearly unused functions)

| Export | File | Notes |
|--------|------|-------|
| `createUserMessageWithAttachments` | `src/agent/attachments.ts:37` | No callers found |
| `getTextContent` | `src/agent/message-types.ts:19` | No callers found |
| `sanitizeUrlForDisplay` | `src/cli.ts:25` | No callers found |
| `saveConfig` | `src/config/loader.ts:204` | No callers found |
| `buildSwarmGuidanceSection` | `src/config/system-prompt.ts:149` | No callers found |

#### Likely dead; needs runtime check (config schemas, types, interfaces)

Many of the 170 unused exports are **config schema sub-objects** (e.g. `TimeoutConfigSchema`, `SecretDetectionConfigSchema`, etc.) and **interface/type exports** consumed only by tests or used for type-inference at declaration sites. These are low-risk but need confirmation that they're not consumed by external tooling (e.g. `typescript-json-schema`).

Notable categories:
- **Config schemas** (~20 exports): Sub-schemas in `src/config/schema.ts`. Used by Zod inference — removing the `export` keyword is safe but doesn't save much.
- **IPC message types** (~30 exports): Contract types in `src/daemon/ipc-contract-types.ts`. May be consumed by Swift codegen scripts.
- **Tool/memory/swarm interfaces** (~40 exports): Type definitions that may be consumed by tests.
- **Utility functions** (~15 exports): Functions like `estimateContentBlockTokens`, `inferMimeType`, `classifyKind`, etc.

#### False positive (dynamic/registry-based)

- All tool registration exports — tools are loaded dynamically via `initializeTools()` in `registry.ts`
- Provider exports — loaded dynamically via `initializeProviders()`
- Event listener registration functions — called at daemon startup

### Unused Types (107 total)

Most are **interface/type** definitions that serve as public API contracts or are consumed by tests. Removing them would break test imports without reducing runtime code.

Categories:
- IPC contract types (~25): Used by codegen pipeline
- Tool result/option types (~20): Used by tests
- Memory/profile types (~15): Used by tests
- Config sub-schemas (~15): Zod inference types
- Remaining (~32): Mix of utility and domain types

---

## Gateway Package

### Unused Dependencies

| Dependency | Confidence | Notes |
|-----------|-----------|-------|
| `pino-pretty` | **Likely dead; needs runtime check** | Typically auto-loaded by pino via CLI transport |
| `zod` | **False positive** | Used for runtime validation; may be tree-shaken by knip |

### Unused Exported Types (7)

| Type | File | Confidence |
|------|------|-----------|
| `BearerAuthResult` | `src/http/auth/bearer.ts:3` | Likely dead — only defines shape, not used externally |
| `OnReply` | `src/http/routes/telegram-webhook.ts:16` | **Skip for now** — callback type, may be used by tests |
| `RuntimeInboundPayload` | `src/runtime/client.ts:6` | **Skip for now** — contract type |
| `RuntimeAttachmentPayload` | `src/runtime/client.ts:26` | **Skip for now** — contract type |
| `UploadAttachmentInput` | `src/runtime/client.ts:131` | **Skip for now** — contract type |
| `UploadAttachmentResponse` | `src/runtime/client.ts:137` | **Skip for now** — contract type |
| `DownloadedFile` | `src/telegram/download.ts:12` | **Skip for now** — used by tests |

---

## Swift Package (Static Inventory)

Swift dead code analysis requires Xcode build. Manual inventory deferred to PR 5.

---

## Summary

| Category | Count | Action |
|----------|-------|--------|
| **Safe delete now** (files) | 3 | PR 4 |
| **Safe delete now** (exports) | ~5 functions | PR 4 |
| **Likely dead** (exports/types) | ~50 | PR 4 (conservative subset) |
| **False positive** | ~220 | No action |
| **Skip for now** | ~10 | Revisit in PR 18 |
