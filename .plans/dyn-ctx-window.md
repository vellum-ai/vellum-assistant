# Dynamic Model Context Windows (opt-in 1M for Opus/Sonnet/others)

## Overview

Today every call site is capped at 200k input tokens — the `llm.default.contextWindow.maxInputTokens` leaf in `assistant/src/config/schemas/llm.ts` and a handful of direct reads of `config.llm.default.contextWindow.maxInputTokens` in the daemon all hardcode it, even though the Anthropic client *already* sends the `context-1m-2025-08-07` beta header unconditionally for non-Haiku models (`assistant/src/providers/anthropic/client.ts:1048-1050`). This plan makes the effective input-token ceiling dynamic — it becomes a function of the resolved model's catalog `contextWindowTokens` crossed with per-call-site config overrides — and opts Anthropic users into 1M only when they explicitly request it. It also replaces every `config.llm.default.contextWindow.maxInputTokens` read with the call-site-aware resolved value so slash-command budget bars, preflight budgets, and tool-result truncation agree on a single number per turn.

## PR 1: Catalog 1M-capable Anthropic model variants

### Depends on
None

### Branch
dyn-ctx-window/pr-1-catalog-opus-1m

### Title
feat(model-catalog): add 1M-context variants for Opus/Sonnet

### Files
- `assistant/src/providers/model-catalog.ts`
- `assistant/src/__tests__/llm-catalog-parity.test.ts`

### Implementation steps

1. In `assistant/src/providers/model-catalog.ts`, add new `CatalogModel` entries inside the Anthropic provider block (`PROVIDER_CATALOG[0].models`, around line 52–115), AFTER each of the three 1M-capable Anthropic models:
   - `{ id: "claude-opus-4-7-1m", displayName: "Claude Opus 4.7 (1M context)", contextWindowTokens: 1_000_000, maxOutputTokens: 32000, supportsThinking: true, supportsCaching: true, supportsVision: true, supportsToolUse: true, pricing: { inputPer1mTokens: 10, outputPer1mTokens: 50, cacheWritePer1mTokens: 12.5, cacheReadPer1mTokens: 1.0 } }` — Anthropic doubles input/output rates above 200k; keep cacheRead and cacheWrite at 2× the base model.
   - `{ id: "claude-opus-4-6-1m", displayName: "Claude Opus 4.6 (1M context)", contextWindowTokens: 1_000_000, ... }` (mirror 4.7 numbers).
   - `{ id: "claude-sonnet-4-6-1m", displayName: "Claude Sonnet 4.6 (1M context)", contextWindowTokens: 1_000_000, maxOutputTokens: 64000, pricing: { inputPer1mTokens: 6, outputPer1mTokens: 30, cacheWritePer1mTokens: 7.5, cacheReadPer1mTokens: 0.6 } }` — Sonnet also doubles above 200k.
   - Do NOT add a Haiku 1M variant — `isHaiku` is specifically excluded from the 1M beta at `assistant/src/providers/anthropic/client.ts:1048` and Haiku does not support the beta upstream.
2. Mirror the same three entries in the OpenRouter provider block (`PROVIDER_CATALOG` entry with `id: "openrouter"`, models array around line 346–410) with ids `anthropic/claude-opus-4.7-1m`, `anthropic/claude-opus-4.6-1m`, `anthropic/claude-sonnet-4.6-1m`. OpenRouter proxies Anthropic's Messages API, so prompt caching and the 1M beta pass through.
3. Leave Gemini/OpenAI/Groq/Fireworks models untouched in this PR — their existing `contextWindowTokens` values (1M for Gemini 2.5 Flash/Flash Lite, 2M for Pro, 400k for GPT-5.x) are already correct.
4. In `assistant/src/__tests__/llm-catalog-parity.test.ts`, the existing parity test compares daemon catalog entries to the macOS-client mirror — no changes needed if the test reads both catalogs generically, but read the file first and update the expected model count or any hardcoded id list that exists (the test around line 148 already verifies `contextWindowTokens` parity generically).
5. Add a focused test in a new describe block inside `llm-catalog-parity.test.ts` (or a new `assistant/src/providers/__tests__/model-catalog-1m.test.ts` if the parity file is tightly scoped) that asserts: (a) `claude-opus-4-7-1m` exists in the Anthropic catalog with `contextWindowTokens === 1_000_000`; (b) the base `claude-opus-4-7` still has `contextWindowTokens === 200_000`; (c) pricing for the `-1m` variant is strictly greater than the base variant (inputPer1mTokens and outputPer1mTokens both > base).

### Acceptance criteria

- `PROVIDER_CATALOG` exposes `claude-opus-4-7-1m`, `claude-opus-4-6-1m`, `claude-sonnet-4-6-1m` under Anthropic and the corresponding `anthropic/*-1m` ids under OpenRouter, each with `contextWindowTokens: 1_000_000` and doubled input/output pricing.
- Base 200k models (`claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`) retain their existing 200k `contextWindowTokens` and base pricing.
- `cd assistant && bunx tsc --noEmit` passes.
- `cd assistant && bun test src/__tests__/llm-catalog-parity.test.ts` passes; any new focused test added in step 5 also passes.

## PR 2: Add `lookupCatalogModel` helper

### Depends on
None

### Branch
dyn-ctx-window/pr-2-catalog-lookup

### Title
feat(model-catalog): add provider+model id lookup helper

### Files
- `assistant/src/providers/model-catalog.ts`
- `assistant/src/providers/__tests__/model-catalog-lookup.test.ts` (new)

### Implementation steps

1. At the bottom of `assistant/src/providers/model-catalog.ts` (after the `PROVIDER_CATALOG` array), add two exported helpers:
   - `export function lookupCatalogModel(provider: string, modelId: string): CatalogModel | undefined` — iterates `PROVIDER_CATALOG`, finds the provider entry by `id`, returns the model entry whose `id === modelId` or `undefined` when either is missing. Case-sensitive; no normalization.
   - `export function getCatalogContextWindowTokens(provider: string, modelId: string): number | undefined` — thin wrapper that returns `lookupCatalogModel(provider, modelId)?.contextWindowTokens`.
2. Do NOT add fallback logic (e.g. "if model not found, return 200k") — callers must handle `undefined` explicitly. This keeps the helper a pure lookup and forces consumers to make a conscious decision about the missing-metadata case.
3. Create `assistant/src/providers/__tests__/model-catalog-lookup.test.ts` covering:
   - `lookupCatalogModel("anthropic", "claude-opus-4-7")` returns the expected model with `contextWindowTokens === 200_000`.
   - `lookupCatalogModel("anthropic", "claude-opus-4-7-1m")` returns `contextWindowTokens === 1_000_000`.
   - `lookupCatalogModel("anthropic", "does-not-exist")` returns `undefined`.
   - `lookupCatalogModel("bogus-provider", "claude-opus-4-7")` returns `undefined`.
   - `getCatalogContextWindowTokens("anthropic", "claude-opus-4-7")` returns `200_000`.
   - `getCatalogContextWindowTokens("anthropic", "missing")` returns `undefined`.
4. No callers are wired to the helper in this PR — subsequent PRs depend on it.

### Acceptance criteria

- `lookupCatalogModel` and `getCatalogContextWindowTokens` are exported from `assistant/src/providers/model-catalog.ts`.
- New lookup test file passes: `cd assistant && bun test src/providers/__tests__/model-catalog-lookup.test.ts`.
- `cd assistant && bunx tsc --noEmit` passes.
- No other files in the repo are changed.

## PR 3: Resolver-level derivation of effective `maxInputTokens`

### Depends on
PR 2

### Branch
dyn-ctx-window/pr-3-resolver-max-input

### Title
feat(llm-resolver): derive effective maxInputTokens from catalog when unset

### Files
- `assistant/src/config/llm-resolver.ts`
- `assistant/src/config/schemas/llm.ts`
- `assistant/src/__tests__/llm-resolver.test.ts`

### Implementation steps

1. In `assistant/src/config/schemas/llm.ts`, change `ContextMaxInputTokensSchema.default(200000)` on **line 177** to `.optional()` — the field becomes an explicit user override rather than a hardcoded constant, and the resolver computes the effective value. Update the `ContextWindow` TypeScript type inference accordingly (the `z.infer` reflects this automatically, so downstream callers that read `.maxInputTokens` will now see `number | undefined`).
2. Because a large number of callers read `config.contextWindow.maxInputTokens` and expect `number`, add a new exported type and helper in `assistant/src/config/llm-resolver.ts`:
   - `export interface ResolvedLLMConfig extends LLMConfigBase { effectiveMaxInputTokens: number }` — superset of `LLMConfigBase` with a guaranteed numeric `effectiveMaxInputTokens`.
   - `resolveCallSiteConfig` now returns `ResolvedLLMConfig` instead of `LLMConfigBase`. Inside `finalize()` (bottom of `llm-resolver.ts` around line 126), after the deep merge, compute `effectiveMaxInputTokens` using precedence: (a) `merged.contextWindow.maxInputTokens` if set (user override), else (b) `getCatalogContextWindowTokens(merged.provider, merged.model)` from PR 2, else (c) fallback to `200_000` (conservative floor; log a warning via `getLogger("llm-resolver").warn` including provider + model so operators can catch a missing catalog entry).
   - The returned object keeps `contextWindow.maxInputTokens` as-is (may be `undefined`) and adds the new `effectiveMaxInputTokens` leaf alongside it. Do NOT mutate `contextWindow.maxInputTokens` itself — the override intent must be distinguishable from the derived value.
3. Update imports: `llm-resolver.ts` must import `getCatalogContextWindowTokens` from `../providers/model-catalog.js` and `getLogger` from `../util/logger.js`.
4. In `assistant/src/__tests__/llm-resolver.test.ts`:
   - Remove the hardcoded `maxInputTokens: 200000` from `fullDefault` at line 18 (the field becomes optional). Update line 136's assertion to read `resolved.effectiveMaxInputTokens` instead of `resolved.contextWindow.maxInputTokens` and expect `200000` because the default model (`claude-opus-4-7`) has `contextWindowTokens: 200_000` in the catalog.
   - Add a new test: "effectiveMaxInputTokens derives from catalog when config omits override" — construct `fullDefault` with `model: "claude-opus-4-7-1m"` and no `contextWindow.maxInputTokens`, expect `resolved.effectiveMaxInputTokens === 1_000_000`.
   - Add a new test: "user override wins over catalog window" — set `contextWindow: { maxInputTokens: 500_000 }` with `model: "claude-opus-4-7-1m"` (catalog = 1M), expect `resolved.effectiveMaxInputTokens === 500_000` AND `resolved.contextWindow.maxInputTokens === 500_000` (override preserved as-is).
   - Add a new test: "unknown model falls back to 200k floor" — set `model: "totally-fake-model"`, no override, expect `resolved.effectiveMaxInputTokens === 200_000`.
5. Do NOT change any consumer code in this PR — `effectiveMaxInputTokens` is introduced but no caller reads it yet. Subsequent PRs migrate consumers one at a time. This keeps the blast radius of the schema change (making `maxInputTokens` optional) confined to the resolver + tests.
6. Because `maxInputTokens` became optional, grep for **all** `config.llm.default.contextWindow.maxInputTokens` reads in the assistant codebase and confirm that each consumer currently expects a `number`. The subsequent PRs migrate them; this PR must leave them compiling. Since Zod's `z.number().int().positive().optional()` widens the TypeScript type from `number` to `number | undefined`, add `?? 200_000` fallbacks at each still-unmigrated call site in this PR to keep the build green:
   - `assistant/src/daemon/conversation-agent-loop.ts:1273`
   - `assistant/src/daemon/conversation-agent-loop.ts:2256`
   - `assistant/src/daemon/server.ts:1520`
   - `assistant/src/runtime/routes/conversation-routes.ts:2080`
   - `assistant/src/daemon/conversation.ts:526`
   - `assistant/src/daemon/conversation-process.ts:263`
   Each becomes `config.llm.default.contextWindow.maxInputTokens ?? 200_000` for now. These fallbacks are temporary and get replaced by call-site-resolved values in later PRs.

### Acceptance criteria

- `LLMConfigBase.contextWindow.maxInputTokens` is optional at the schema level; `LLMConfigBase.parse({})` no longer injects `200000`.
- `resolveCallSiteConfig` returns a `ResolvedLLMConfig` with `effectiveMaxInputTokens: number` always populated.
- Precedence verified by `llm-resolver.test.ts` additions: user override > catalog > 200k floor.
- `cd assistant && bunx tsc --noEmit` passes (no `undefined is not assignable to number` errors).
- `cd assistant && bun test src/__tests__/llm-resolver.test.ts` passes.

## PR 4: Gate Anthropic 1M beta on effective context window

### Depends on
PR 3

### Branch
dyn-ctx-window/pr-4-anthropic-1m-gate

### Title
fix(anthropic): only send 1M context beta when effective window > 200k

### Files
- `assistant/src/providers/anthropic/client.ts`
- `assistant/src/providers/__tests__/anthropic-beta-headers.test.ts` (new)

### Implementation steps

1. In `assistant/src/providers/anthropic/client.ts`, the beta header list at **line 1048** unconditionally includes `"context-1m-2025-08-07"` for non-Haiku. This is wrong when the caller wants the default 200k — it silently enables 1M pricing on every Opus/Sonnet request that exceeds 200k. Replace this with a call-site-aware gate:
   - The client needs to know the effective context window for the current request. Widen `SendMessageOptions` (in `assistant/src/providers/types.ts`) to include an optional `effectiveMaxInputTokens?: number` field. Callers that know the resolved call-site config pass this value; callers that don't, omit it and get the 200k default behavior.
   - In `client.ts` around line 1042, derive `const wants1m = (config as SendMessageOptions).effectiveMaxInputTokens != null && (config as SendMessageOptions).effectiveMaxInputTokens > 200_000;` (type-safe cast — the field is already part of the widened `SendMessageOptions`).
   - Update the beta assembly at line 1048 to:
     ```ts
     const betas: string[] = isHaiku
       ? []
       : wants1m
         ? ["extended-cache-ttl-2025-04-11", "context-1m-2025-08-07"]
         : ["extended-cache-ttl-2025-04-11"];
     ```
     Non-Haiku models still get the extended-cache-ttl beta (a separate feature); only the 1M beta is gated on `wants1m`.
2. Update the comment at lines 1045–1047 to reflect the new behavior: "Collect required betas: extended cache TTL for 1h system prompt caching (all non-Haiku models), and 1M context window only when the resolved effective max-input-tokens exceeds 200k. Haiku does not support either beta."
3. Create `assistant/src/providers/__tests__/anthropic-beta-headers.test.ts` — mock the Anthropic SDK's `client.beta.messages.stream` and `client.messages.stream` so the test can spy on the `betas` array passed. Verify:
   - Default Opus 4.7 call (no `effectiveMaxInputTokens` in options) sends `["extended-cache-ttl-2025-04-11"]` only — NOT the 1M beta.
   - Opus 4.7 call with `effectiveMaxInputTokens: 1_000_000` sends `["extended-cache-ttl-2025-04-11", "context-1m-2025-08-07"]`.
   - Opus 4.7 call with `effectiveMaxInputTokens: 200_000` (explicit 200k) sends only `["extended-cache-ttl-2025-04-11"]`.
   - Haiku call with `effectiveMaxInputTokens: 1_000_000` sends no betas (`[]`) — Haiku gate takes precedence.
   - Fast-mode Opus call with `effectiveMaxInputTokens: 1_000_000` sends `["extended-cache-ttl-2025-04-11", "context-1m-2025-08-07", "fast-mode-2026-02-01"]`.
4. Because no caller passes `effectiveMaxInputTokens` yet (that wiring is PR 6), this PR's behavior change for *real* traffic is: **1M beta is no longer sent by default**. That is an intentional correctness fix — the beta changes billing, so it should not be on silently. Users who want 1M opt in via PR 5's config/catalog wiring.
5. Flag this on the PR description as a billing-behavior change so reviewers understand: existing users with conversations under 200k were silently paying at 1M rates? No — the beta changes the *cap*, not the rates at current token counts. But sending the beta locks the request into 1M-tier pricing once tokens exceed 200k, which could silently charge double for long conversations. Document this in the commit body.

### Acceptance criteria

- `assistant/src/providers/anthropic/client.ts` sends the `context-1m-2025-08-07` beta only when `effectiveMaxInputTokens > 200_000` is explicitly set on the options.
- `extended-cache-ttl-2025-04-11` continues to be sent unconditionally for non-Haiku.
- Haiku still gets no betas.
- `cd assistant && bun test src/providers/__tests__/anthropic-beta-headers.test.ts` passes.
- `cd assistant && bunx tsc --noEmit` passes.

## PR 5: Plumb resolved `effectiveMaxInputTokens` through SendMessageOptions

### Depends on
PR 3

### Branch
dyn-ctx-window/pr-5-plumb-effective-max

### Title
feat(providers): carry effectiveMaxInputTokens through SendMessageOptions

### Files
- `assistant/src/providers/types.ts`
- `assistant/src/providers/retry.ts`
- `assistant/src/providers/call-site-routing.ts`
- `assistant/src/__tests__/agent-loop-callsite-precedence.test.ts`

### Implementation steps

1. In `assistant/src/providers/types.ts`, add the optional field to `SendMessageOptions`:
   ```ts
   /**
    * Call-site-resolved effective max input tokens. Populated by the
    * call-site routing layer from ResolvedLLMConfig.effectiveMaxInputTokens.
    * Providers use this to (a) gate capability betas (e.g. Anthropic's 1M
    * beta), (b) compute pre-send token budgets. When absent, providers
    * should behave as if the value were 200_000 (conservative default).
    */
   effectiveMaxInputTokens?: number;
   ```
2. In `assistant/src/providers/call-site-routing.ts` (around line 63 where `resolveCallSiteConfig` is called), after resolving the config, populate `options.effectiveMaxInputTokens = resolved.effectiveMaxInputTokens` onto the outbound `SendMessageOptions` passed down to the underlying provider. This is the single chokepoint that every call-site-routed provider invocation flows through, so one edit covers every call site that uses `CallSiteRoutingProvider`.
3. In `assistant/src/providers/retry.ts` (around line 118 where `resolveCallSiteConfig` is called), do the same: inject `effectiveMaxInputTokens` into the options that `runWithRetry` forwards to the provider. The retry wrapper re-resolves on every attempt, so a mid-stream config reload is reflected.
4. No change to `provider-send-message.ts` — that file resolves only the `provider` field for lazy initialization and does not control per-request options.
5. Update `assistant/src/__tests__/agent-loop-callsite-precedence.test.ts` (precedence test) with a new case that asserts `options.effectiveMaxInputTokens` is forwarded correctly when the call site resolves to a 1M model.
6. The Anthropic client (from PR 4) now receives this field on real traffic and activates the 1M beta for any call site whose resolved model has `contextWindowTokens > 200_000` OR whose config explicitly overrides `maxInputTokens > 200_000`.
7. Non-Anthropic providers (OpenAI, Gemini, OpenRouter, Ollama, Fireworks) ignore the new field — it's optional and they don't read it. Document this in the field's JSDoc.

### Acceptance criteria

- Every call-site-routed LLM request carries `effectiveMaxInputTokens` on `SendMessageOptions`.
- `CallSiteRoutingProvider` and the retry wrapper both inject the field.
- Anthropic client (PR 4) now sends the 1M beta whenever the resolved call site is on a 1M model.
- `cd assistant && bunx tsc --noEmit` passes.
- `cd assistant && bun test src/__tests__/agent-loop-callsite-precedence.test.ts src/providers/__tests__/anthropic-beta-headers.test.ts` passes.

## PR 6: Migrate direct `config.llm.default.contextWindow.maxInputTokens` reads to resolved values

### Depends on
PR 3

### Branch
dyn-ctx-window/pr-6-migrate-direct-reads

### Title
refactor(daemon): source maxInputTokens from resolved call-site config

### Files
- `assistant/src/daemon/conversation-agent-loop.ts`
- `assistant/src/daemon/conversation.ts`
- `assistant/src/daemon/conversation-process.ts`
- `assistant/src/daemon/server.ts`
- `assistant/src/runtime/routes/conversation-routes.ts`

### Implementation steps

1. The bug this PR fixes: `config.llm.default.contextWindow.maxInputTokens` is read directly at six sites (see the file list). Each ignores per-call-site overrides — e.g. if `llm.callSites.mainAgent.model === "claude-opus-4-7-1m"`, the slash-command `/context` bar and the preflight budget still use the default's 200k. After this PR every read uses `resolveCallSiteConfig(callSite, config.llm).effectiveMaxInputTokens`.
2. `assistant/src/daemon/conversation-agent-loop.ts:1273` — replace `const providerMaxTokens = config.llm.default.contextWindow.maxInputTokens;` with `const providerMaxTokens = resolveCallSiteConfig(turnCallSite, config.llm).effectiveMaxInputTokens;`. `turnCallSite` is already in scope at line 610. Import `resolveCallSiteConfig` from `../config/llm-resolver.js` at the top of the file.
3. `assistant/src/daemon/conversation-agent-loop.ts:2256` — same substitution: `maxTokens: resolveCallSiteConfig(turnCallSite, config.llm).effectiveMaxInputTokens,` — keeping `maxTokens` as the outbound SlashContext/event-emitter field name since that is a separate wire contract.
4. `assistant/src/daemon/conversation.ts:526` — the `AgentLoop` construction reads `llmDefault.contextWindow.maxInputTokens`. The conversation-level call site for mainAgent turns is `"mainAgent"` here. Replace with `maxInputTokens: resolveCallSiteConfig("mainAgent", config.llm).effectiveMaxInputTokens,` and update the `ContextWindowManager` instantiation a few lines below (around line 542) to pass the same value into `config: { ...llmDefault.contextWindow, maxInputTokens: resolveCallSiteConfig("mainAgent", config.llm).effectiveMaxInputTokens }`. Extract this to a local `const mainAgentResolved = resolveCallSiteConfig("mainAgent", config.llm);` at the top of the method to avoid re-resolving. Import `resolveCallSiteConfig` and `getConfig` as needed.
5. `assistant/src/daemon/conversation-process.ts:263` and `assistant/src/daemon/server.ts:1520` — both build a `SlashContext`. Replace `maxInputTokens: config.llm.default.contextWindow.maxInputTokens` with `maxInputTokens: resolveCallSiteConfig("mainAgent", config.llm).effectiveMaxInputTokens`.
6. `assistant/src/runtime/routes/conversation-routes.ts:2080` — same substitution as above (SlashContext on the HTTP route).
7. Remove the temporary `?? 200_000` fallbacks added in PR 3 step 6 from each of these sites — after this PR they're unreachable because `effectiveMaxInputTokens` is always a concrete number.
8. Add one test covering the behavior that motivates the change: in `assistant/src/__tests__/conversation-slash-commands.test.ts` (or whichever existing test exercises `SlashContext.maxInputTokens` — grep for `maxInputTokens: 200000` to find candidates), add a case that sets `llm.callSites.mainAgent = { model: "claude-opus-4-7-1m" }` and asserts the `SlashContext.maxInputTokens` produced by the daemon reflects 1M, not the 200k default. If no existing test is a good fit, create `assistant/src/__tests__/dyn-ctx-window-slash-context.test.ts`.

### Acceptance criteria

- Every `config.llm.default.contextWindow.maxInputTokens` read in the daemon is replaced with a `resolveCallSiteConfig(<callSite>, config.llm).effectiveMaxInputTokens` read.
- `/context` slash bar, preflight budget, and `ContextWindowManager` all agree with the per-call-site resolved value.
- `cd assistant && bun test src/__tests__/conversation-slash-commands.test.ts src/__tests__/conversation-agent-loop-overflow.test.ts src/__tests__/context-window-manager.test.ts` passes.
- `cd assistant && bunx tsc --noEmit` passes.
- `grep -rn 'config\.llm\.default\.contextWindow\.maxInputTokens' assistant/src` returns zero matches in non-test source files.

## PR 7: Seed `contextWindow: 1000000` on mainAgent when model is a 1M variant

### Depends on
PR 3

### Branch
dyn-ctx-window/pr-7-seed-1m-migration

### Title
chore(workspace-migrations): seed 1M window when mainAgent is a 1M model

### Files
- `assistant/src/workspace/migrations/051-seed-1m-contextwindow-callsite.ts` (new)
- `assistant/src/workspace/migrations/registry.ts`
- `assistant/src/__tests__/workspace-migration-seed-1m-contextwindow.test.ts` (new)

### Implementation steps

1. With PR 3 landed, a user who manually edits their `config.json` to set `llm.callSites.mainAgent.model = "claude-opus-4-7-1m"` already gets a 1M `effectiveMaxInputTokens` automatically — nothing to migrate for that path. The migration this PR adds is for the *inverse*: any pre-existing `llm.callSites.*` that ended up with `contextWindow: { maxInputTokens: 1_000_000 }` (because some operator hand-set it before this plan landed) should be normalized by removing the now-redundant override so catalog inheritance takes over cleanly.
2. Actually, skip normalization for v1 — it's an optimization, not a correctness fix, and removing user-set config fields is risky. Instead, make this PR purely additive: a **no-op forward-only migration** that logs a one-line info message when a user's `mainAgent` call site is on a 1M model but the `contextWindow.maxInputTokens` override is absent, so operators can confirm the new resolver path is live. Pattern copied from `050-seed-main-agent-opus-callsite.ts`.
3. Create `assistant/src/workspace/migrations/051-seed-1m-contextwindow-callsite.ts` with the following shape:
   ```ts
   export const seed1mContextWindowCallsiteMigration: WorkspaceMigration = {
     id: "051-seed-1m-contextwindow-callsite",
     description: "Log when mainAgent is on a 1M Anthropic model (resolver-driven)",
     run(workspaceDir: string): void {
       // No mutation. Just observational logging via stdout/stderr
       // (getLogger is not available at migration time).
       const configPath = join(workspaceDir, "config.json");
       if (!existsSync(configPath)) return;
       try {
         const raw = JSON.parse(readFileSync(configPath, "utf-8"));
         const mainAgent = raw?.llm?.callSites?.mainAgent;
         const model = typeof mainAgent?.model === "string" ? mainAgent.model : undefined;
         if (model && model.endsWith("-1m")) {
           console.error(`[migration 051] mainAgent model "${model}" — 1M context window active via catalog.`);
         }
       } catch { /* ignore malformed config */ }
     },
     down(): void { /* forward-only */ },
   };
   ```
4. In `assistant/src/workspace/migrations/registry.ts`, append `seed1mContextWindowCallsiteMigration` to the END of the `WORKSPACE_MIGRATIONS` array (after `seedMainAgentOpusCallsiteMigration` on line 109). Add the import at the top following the ordered pattern (line ~51 area).
5. Create `assistant/src/__tests__/workspace-migration-seed-1m-contextwindow.test.ts`:
   - Test: migration is idempotent — run twice on the same workspace, no errors.
   - Test: migration handles missing `config.json` without throwing.
   - Test: migration handles malformed JSON without throwing.
   - Test: migration emits the expected `console.error` line when `mainAgent.model` ends with `-1m`.
   - Test: migration is silent when `mainAgent.model` does not end with `-1m`.

### Acceptance criteria

- Migration 051 is appended to `WORKSPACE_MIGRATIONS` and runs cleanly on fresh and existing workspaces.
- Migration is observational (no file mutations).
- `cd assistant && bun test src/__tests__/workspace-migration-seed-1m-contextwindow.test.ts` passes.
- `cd assistant && bunx tsc --noEmit` passes.

## PR 8: Release notes + documentation for dynamic context windows

### Depends on
PR 1, PR 3, PR 4, PR 5, PR 6, PR 7

### Branch
dyn-ctx-window/pr-8-release-notes

### Title
docs(release-notes): document 1M context window opt-in

### Files
- `assistant/src/workspace/migrations/052-release-notes-1m-context.ts` (new)
- `assistant/src/workspace/migrations/registry.ts`
- `assistant/src/__tests__/workspace-migration-seed-1m-contextwindow.test.ts` (extend, if co-located) or new release-notes test file

### Implementation steps

1. Add a release-notes workspace migration at `assistant/src/workspace/migrations/052-release-notes-1m-context.ts`. Follow the pattern documented in the repo-root `CLAUDE.md` "Release Update Hygiene" section — the migration appends a block to `<workspace>/UPDATES.md` with an HTML marker `<!-- release-note-id:052-release-notes-1m-context -->` and short-circuits if the marker is already present. Copy the structural skeleton from the most recent release-notes migration in the repo (e.g. `049-release-notes-default-sonnet.ts` or `045-release-notes-meet-avatar.ts`).
2. Release-note content (kept short, user-facing, uses "assistant" not "daemon"):
   ```
   **Longer context windows.** Anthropic's Claude Opus and Sonnet now support up to 1M input tokens. To opt in, set your mainAgent model to one of the new variants: `claude-opus-4-7-1m`, `claude-opus-4-6-1m`, or `claude-sonnet-4-6-1m`. The 1M tier costs roughly 2× the 200k base rate for input and output tokens — the assistant sends the `context-1m-2025-08-07` beta header automatically and only when you pick a 1M variant. Per-call-site overrides also work: `llm.callSites.mainAgent.contextWindow.maxInputTokens: 500000` caps the window at 500k without switching models. Models that natively support 1M+ (Gemini 2.5 Flash/Pro, GPT-5.x at 400k) already have their native windows respected.
   ```
3. Append `releaseNotes1mContextMigration` to `WORKSPACE_MIGRATIONS` in `registry.ts` AFTER migration 051 (append-only).
4. Add a test in a new file `assistant/src/__tests__/workspace-migration-release-notes-1m.test.ts` that: (a) runs the migration on a workspace with an empty `UPDATES.md`, asserts the content is appended and contains the marker; (b) runs it again, asserts the file is unchanged (idempotent via the marker short-circuit); (c) runs it on a workspace with no `UPDATES.md`, asserts the file is created and contains the content.
5. No changes to `ARCHITECTURE.md` or domain docs — this plan does not reshape architecture, it exercises existing knobs. If a section of `docs/` documents the llm config schema, update that page to mention that `maxInputTokens` is now optional and defaults to the resolved model's catalog window. Grep for "maxInputTokens" in `docs/` to find the right page.
6. Not a blocking item for this PR, but flag in the PR description: after merge, update the user-facing "models" help in macOS client and/or CLI to surface the `-1m` variants in any selector UI. Those changes live in `clients/` and are out of scope for this plan — open a follow-up issue.

### Acceptance criteria

- Migration 052 appends release notes with the required HTML marker and is idempotent.
- Migration is registered in `registry.ts` AFTER migration 051.
- New release-notes test passes.
- `cd assistant && bunx tsc --noEmit` passes.
