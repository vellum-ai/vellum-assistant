# Enforce zero imports between `assistant/` and `skills/`

## Overview

Today `skills/meet-join/` has 19 files that import from `assistant/src/` (59 runtime + 29 type), and `assistant/src/daemon/external-skills-bootstrap.ts` is the sanctioned single line that imports into `skills/`. This plan eliminates all imports in both directions, enforced by a bidirectional guard test. Phase 1 replaces skill→assistant imports with a runtime-injected `SkillHost` in a neutral package. Phase 2 externalizes meet-join into its own `bun run`-launched process (lazy-spawned on first meet use, not pre-compiled; ships source + bun runtime + manifest) so the bootstrap import can be deleted.

## PR 1: Create `packages/skill-host-contracts/` package skeleton

### Depends on
None

### Branch
skill-isolation/pr-1-skill-host-contracts-skeleton

### Title
chore(skill-host-contracts): add empty package skeleton

### Files
- `packages/skill-host-contracts/package.json`
- `packages/skill-host-contracts/tsconfig.json`
- `packages/skill-host-contracts/src/index.ts`
- `package.json` (root)

### Implementation steps
1. Create `packages/skill-host-contracts/package.json` with `name: "@vellumai/skill-host-contracts"`, `type: "module"`, `main: "./src/index.ts"`, `types: "./src/index.ts"`. Mirror the style of `packages/ces-contracts/package.json`.
2. Create `packages/skill-host-contracts/tsconfig.json` extending the repo base, with `moduleResolution: "NodeNext"` and `.js` import suffixes.
3. Create `packages/skill-host-contracts/src/index.ts` as an empty module (`export {};`).
4. Update the root `package.json` workspaces array to include `packages/skill-host-contracts` if not already covered by a glob. Check how `ces-contracts` is listed.
5. Run `bun install` at the repo root to make the workspace resolve.

### Acceptance criteria
- `bunx tsc --noEmit` passes in the new package.
- Other packages can resolve `@vellumai/skill-host-contracts` via `bun install`.
- Guard tests (if any) still pass.

## PR 2: Move `AssistantEvent` + `buildAssistantEvent` into the package

### Depends on
PR 1

### Branch
skill-isolation/pr-2-move-assistant-event

### Title
refactor(skill-host-contracts): move AssistantEvent types into neutral package

### Files
- `packages/skill-host-contracts/src/assistant-event.ts`
- `packages/skill-host-contracts/src/index.ts`
- `assistant/src/runtime/assistant-event.ts`

### Implementation steps
1. Copy the type/interface declarations (`AssistantEvent`, related discriminants) and `buildAssistantEvent()` helper from `assistant/src/runtime/assistant-event.ts` into `packages/skill-host-contracts/src/assistant-event.ts`.
2. In `assistant/src/runtime/assistant-event.ts`, replace the original declarations with a thin re-export: `export * from "@vellumai/skill-host-contracts/assistant-event";` (or equivalent path). Keep all existing import sites in `assistant/` pointing at the existing file path — no caller changes.
3. Add the exports to `packages/skill-host-contracts/src/index.ts`.

### Acceptance criteria
- `bunx tsc --noEmit` passes in both `assistant/` and the package.
- Existing runtime tests in `assistant/src/runtime/` pass unchanged.
- `git grep "buildAssistantEvent"` still resolves to working code.

## PR 3: Move `ServerMessage` discriminated union into the package

### Depends on
PR 1

### Branch
skill-isolation/pr-3-move-server-message

### Title
refactor(skill-host-contracts): move ServerMessage wire type into neutral package

### Files
- `packages/skill-host-contracts/src/server-message.ts`
- `packages/skill-host-contracts/src/index.ts`
- `assistant/src/daemon/message-protocol.ts`

### Implementation steps
1. Copy the `ServerMessage` union, sub-types it references directly in the union declaration, and any companion type-guards from `assistant/src/daemon/message-protocol.ts` into `packages/skill-host-contracts/src/server-message.ts`. Leave the per-domain sub-message files (e.g. `assistant/src/daemon/message-types/meet.ts`) where they are; only move the union authoring.
2. In `assistant/src/daemon/message-protocol.ts`, replace the moved code with a thin re-export from the package.
3. Add exports to `packages/skill-host-contracts/src/index.ts`.

### Acceptance criteria
- `bunx tsc --noEmit` clean.
- Message-protocol related tests pass unchanged.
- All existing `ServerMessage` importers still resolve.

## PR 4: Move tool types into the package

### Depends on
PR 1

### Branch
skill-isolation/pr-4-move-tool-types

### Title
refactor(skill-host-contracts): move Tool/RiskLevel type defs into neutral package

### Files
- `packages/skill-host-contracts/src/tool-types.ts`
- `packages/skill-host-contracts/src/index.ts`
- `assistant/src/tools/types.ts`

### Implementation steps
1. Copy the type definitions `Tool`, `ToolDefinition`, `ToolContext`, `ToolExecutionResult`, and the `RiskLevel` enum from `assistant/src/tools/types.ts` into `packages/skill-host-contracts/src/tool-types.ts`. Keep only type-level declarations in the package — runtime helpers stay in `assistant/`.
2. In `assistant/src/tools/types.ts`, replace the moved declarations with re-exports from the package. Leave behavior helpers (non-type functions) where they are.
3. Add package exports to `src/index.ts`.

### Acceptance criteria
- `bunx tsc --noEmit` clean across `assistant/` and the package.
- Existing tools/tests still compile and pass.

## PR 5: Move `DaemonRuntimeMode` enum into the package

### Depends on
PR 1

### Branch
skill-isolation/pr-5-move-runtime-mode

### Title
refactor(skill-host-contracts): move DaemonRuntimeMode enum into neutral package

### Files
- `packages/skill-host-contracts/src/runtime-mode.ts`
- `packages/skill-host-contracts/src/index.ts`
- `assistant/src/runtime/runtime-mode.ts` (or wherever the enum currently lives)

### Implementation steps
1. Locate the `DaemonRuntimeMode` enum (likely `assistant/src/runtime/runtime-mode.ts`). Copy the enum declaration into `packages/skill-host-contracts/src/runtime-mode.ts`.
2. In the original file, replace the declaration with a re-export. Keep `getDaemonRuntimeMode()` (the runtime getter) in `assistant/` — only the type/enum moves.
3. Add to `src/index.ts`.

### Acceptance criteria
- `bunx tsc --noEmit` clean.
- All existing `DaemonRuntimeMode` imports still resolve.

## PR 6: Define `SkillHost` interface in the package

### Depends on
PR 2, PR 3, PR 4, PR 5

### Branch
skill-isolation/pr-6-skill-host-interface

### Title
feat(skill-host-contracts): define SkillHost interface

### Files
- `packages/skill-host-contracts/src/skill-host.ts`
- `packages/skill-host-contracts/src/index.ts`

### Implementation steps
1. Create `packages/skill-host-contracts/src/skill-host.ts` with the `SkillHost` interface — exactly the shape laid out in the overview plan: `logger`, `config`, `identity`, `platform`, `providers` (llm/stt/tts/secureKeys), `memory`, `events`, `registries`, `speakers`. Type every method; reference the moved types from PRs 2-5.
2. Also declare the helper interfaces this depends on: `Logger`, `SttSpec`, `StreamingTranscriber`, `TtsProvider`, `TtsConfig`, `Provider`, `InsertMessageFn`, `WakeOpportunity`, `SkillRoute`, `SkillRouteHandle`, `SpeakerIdentityTracker`, `Filter`, `AssistantEventCallback`, `Subscription`. Keep them interface-only — zero runtime code.
3. Export everything from `src/index.ts`.

### Acceptance criteria
- `bunx tsc --noEmit` clean.
- Interface is importable as `import type { SkillHost } from "@vellumai/skill-host-contracts";`.

## PR 7: Add `DaemonSkillHost` implementation in `assistant/`

### Depends on
PR 6

### Branch
skill-isolation/pr-7-daemon-skill-host

### Title
feat(daemon): add DaemonSkillHost implementation bridging skill-host interface to daemon singletons

### Files
- `assistant/src/daemon/daemon-skill-host.ts`
- `assistant/src/daemon/__tests__/daemon-skill-host.test.ts`

### Implementation steps
1. Create `assistant/src/daemon/daemon-skill-host.ts` exporting `createDaemonSkillHost(skillId: string): SkillHost`. Every method delegates to the daemon's existing modules: `logger.get` → `getLogger`; `config.isFeatureFlagEnabled` → `isAssistantFeatureFlagEnabled`; `config.getSection` → `getConfig`; `identity.*` → `getAssistantName` + `DAEMON_INTERNAL_ASSISTANT_ID`; `platform.*` → `getWorkspaceDir` + `vellumRoot` + `getDaemonRuntimeMode`; `providers.*` → existing provider accessors; `memory.*` → existing memory functions; `events.*` → `assistantEventHub`; `registries.*` → `registerExternalTools`/`registerSkillRoute`/`registerShutdownHook`; `speakers.createTracker` → `new SpeakerIdentityTracker(...)`.
2. Add a unit test `__tests__/daemon-skill-host.test.ts` that constructs the host with a stub skillId, asserts each facet exists and is callable (shallow smoke test), and mocks the delegated modules where necessary (`mock.module(...)`) to avoid touching real singletons.

### Acceptance criteria
- `bun test assistant/src/daemon/__tests__/daemon-skill-host.test.ts` passes.
- `bunx tsc --noEmit` clean.
- `createDaemonSkillHost` constructs without errors when called from a fake bootstrap harness.

## PR 8: Rewrite `skills/meet-join/register.ts` to accept `SkillHost`; wire bootstrap

### Depends on
PR 7

### Branch
skill-isolation/pr-8-register-accepts-host

### Title
refactor(meet-join): register(host) signature; bootstrap constructs DaemonSkillHost

### Files
- `skills/meet-join/register.ts`
- `skills/meet-join/daemon/modules-registry.ts` (new — module slot registry to avoid register.ts conflicts in later PRs)
- `assistant/src/daemon/external-skills-bootstrap.ts`

### Implementation steps
1. Introduce `skills/meet-join/daemon/modules-registry.ts` — a simple in-skill registry that exposes named slots for each sub-module factory (e.g. `registerSubModule("event-publisher", factory)`, `getSubModule("event-publisher")`). Purpose: subsequent sub-module conversion PRs register their factory into this registry without touching `register.ts`, eliminating merge-conflict hotspots.
2. Rewrite `skills/meet-join/register.ts` to export `register(host: SkillHost): void`. Inside, call `host.registries.registerTools(() => { ... })` (feature-flag-gated tool builder), `host.registries.registerSkillRoute(...)`, and any `registerShutdownHook` calls. It also reads the modules-registry to build sub-module instances during tool/route setup. Keep the current `registerExternalTools`/etc. call semantics identical — just source them from `host.registries` instead of direct imports. Do NOT migrate internal skill files' imports yet — just the signature change.
3. Update `assistant/src/daemon/external-skills-bootstrap.ts` to import `register` from `skills/meet-join/register.js` (named, not side-effect) and call `register(createDaemonSkillHost("meet-join"))`. Keep the single-line comment explaining the sanctioned exception.

### Acceptance criteria
- Daemon starts successfully; meet tools register and are visible to the LLM (verify via existing `bunx tsc --noEmit` + `bun test` for tool-registry tests).
- Meet feature still works: run `vellum up` and verify that `meet_join` tool executes end-to-end against a real meeting.
- `skills/meet-join/register.ts` has zero `assistant/` imports (its own migration).

## PR 9: Convert `event-publisher.ts` + `conversation-bridge.ts` to host-based factories

### Depends on
PR 8

### Branch
skill-isolation/pr-9-migrate-events-cluster

### Title
refactor(meet-join): migrate event-publisher + conversation-bridge to SkillHost

### Files
- `skills/meet-join/daemon/event-publisher.ts`
- `skills/meet-join/daemon/conversation-bridge.ts`
- `skills/meet-join/daemon/modules-registry.ts` (register these factories)

### Implementation steps
1. Refactor `event-publisher.ts` from a class/module with top-level imports to `createEventPublisher(host: SkillHost): EventPublisher`. Replace `assistantEventHub.publish` → `host.events.publish`, `buildAssistantEvent` → `host.events.buildEvent`, `getLogger` → `host.logger.get`. Remove all `assistant/` imports.
2. Same treatment for `conversation-bridge.ts`: factory `createConversationBridge(host)` that uses `host.events.*`, `host.identity.internalAssistantId`, `host.logger.get`. The existing `AssistantEventPublisher` interface at line 83 is already close — remove `ServerMessage` import (comes from `@vellumai/skill-host-contracts` now via `host` contract or type).
3. Register both factories into `modules-registry.ts` so `session-manager.ts` can consume them later (PR 17).
4. Update any direct consumers within these two files to go through host where possible.

### Acceptance criteria
- `grep -E 'from "[^"]*\.\./\.\./\.\./assistant/'` returns empty in both files.
- Unit tests for these modules (if present) pass with a fake `SkillHost` built by `buildTestHost()` helper (add it to the skill's `__tests__/` if not already present).
- `bunx tsc --noEmit` clean.

## PR 10: Convert `audio-ingest.ts` + `speaker-resolver.ts` to host-based factories

### Depends on
PR 8

### Branch
skill-isolation/pr-10-migrate-audio-cluster

### Title
refactor(meet-join): migrate audio-ingest + speaker-resolver to SkillHost

### Files
- `skills/meet-join/daemon/audio-ingest.ts`
- `skills/meet-join/daemon/speaker-resolver.ts`
- `skills/meet-join/daemon/modules-registry.ts`

### Implementation steps
1. `audio-ingest.ts` → `createAudioIngest(host)`. Replace `listProviderIds`/`supportsBoundary`/`resolveStreamingTranscriber` with `host.providers.stt.*`. Replace `getLogger` with `host.logger.get`. Remove all `assistant/` imports.
2. `speaker-resolver.ts` → `createSpeakerResolver(host)`. Replace direct `SpeakerIdentityTracker` instantiation with `host.speakers.createTracker()`. Replace logger. Remove all `assistant/` imports.
3. Register factories in `modules-registry.ts`.

### Acceptance criteria
- Zero `assistant/` imports in both files.
- Unit tests pass with fake host.
- `bunx tsc --noEmit` clean.

## PR 11: Convert `tts-bridge.ts` + `tts-lipsync.ts` to host-based factories

### Depends on
PR 8

### Branch
skill-isolation/pr-11-migrate-tts-cluster

### Title
refactor(meet-join): migrate tts-bridge + tts-lipsync to SkillHost

### Files
- `skills/meet-join/daemon/tts-bridge.ts`
- `skills/meet-join/daemon/tts-lipsync.ts`
- `skills/meet-join/daemon/modules-registry.ts`

### Implementation steps
1. `tts-bridge.ts` → `createTtsBridge(host)`. Replace `getTtsProvider`/`resolveTtsConfig` with `host.providers.tts.*`. Replace `getProviderKeyAsync` with `host.providers.secureKeys.getProviderKey`. Replace logger.
2. `tts-lipsync.ts` → `createTtsLipsync(host)`. Same treatment for its imports.
3. Register factories in `modules-registry.ts`.

### Acceptance criteria
- Zero `assistant/` imports.
- Unit tests pass with fake host.
- `bunx tsc --noEmit` clean.

## PR 12: Convert the observer cluster to host-based factories

### Depends on
PR 8

### Branch
skill-isolation/pr-12-migrate-observers

### Title
refactor(meet-join): migrate observer modules (barge-in, chat-opportunity, consent, session-event-router, storage-writer) to SkillHost

### Files
- `skills/meet-join/daemon/barge-in-watcher.ts`
- `skills/meet-join/daemon/chat-opportunity-detector.ts`
- `skills/meet-join/daemon/consent-monitor.ts`
- `skills/meet-join/daemon/session-event-router.ts`
- `skills/meet-join/daemon/storage-writer.ts`
- `skills/meet-join/daemon/modules-registry.ts`

### Implementation steps
1. Convert each file to its `create<Name>(host)` factory. Replace `getLogger`, `assistantEventHub.*`, `DAEMON_INTERNAL_ASSISTANT_ID`, config accessors, and any other daemon singletons with `host.*` equivalents.
2. Bundle these 5 observers into one PR because each is individually small (10-50 LOC of changes) and they share similar refactor shapes. No per-file parallelism needed.
3. Register each factory in `modules-registry.ts`.

### Acceptance criteria
- Zero `assistant/` imports in all 5 files.
- Unit tests (if present) pass with fake host.
- `bunx tsc --noEmit` clean.

## PR 13: Convert `docker-runner.ts` to host-based factory

### Depends on
PR 8

### Branch
skill-isolation/pr-13-migrate-docker-runner

### Title
refactor(meet-join): migrate docker-runner to SkillHost

### Files
- `skills/meet-join/daemon/docker-runner.ts`
- `skills/meet-join/daemon/modules-registry.ts`

### Implementation steps
1. `docker-runner.ts` → `createDockerRunner(host)`. Replace `getDaemonRuntimeMode` with `host.platform.runtimeMode()`, `vellumRoot`/`getWorkspaceDir` with `host.platform.*`, `getLogger` with `host.logger.get`. Preserve all existing Docker API logic.
2. Register factory in `modules-registry.ts`.

### Acceptance criteria
- Zero `assistant/` imports in the file.
- Existing meet-session-manager Docker spawn path still works end-to-end (verified by a real Meet session after PR 17 lands).
- `bunx tsc --noEmit` clean.

## PR 14: Convert `tools/meet-*-tool.ts` to host-based factories

### Depends on
PR 8

### Branch
skill-isolation/pr-14-migrate-tools

### Title
refactor(meet-join): migrate all meet tool files to SkillHost

### Files
- `skills/meet-join/tools/meet-avatar-tool.ts`
- `skills/meet-join/tools/meet-speak-tool.ts`
- `skills/meet-join/tools/meet-send-chat-tool.ts`
- `skills/meet-join/tools/meet-join-tool.ts`
- `skills/meet-join/tools/meet-leave-tool.ts`
- `skills/meet-join/register.ts` (consume factories)

### Implementation steps
1. For each of the 5 tool files, convert the class-instance singleton export (e.g. `meetEnableAvatarTool`, `meetJoinTool`) into a factory `create<Name>Tool(host: SkillHost): Tool`. Replace `isAssistantFeatureFlagEnabled`/`getConfig` with `host.config.*`, `RiskLevel`/`ToolContext`/`Tool` with imports from `@vellumai/skill-host-contracts`, `getLogger` with `host.logger.get`.
2. Update `register.ts` to invoke these factories inside its `host.registries.registerTools(() => [...])` provider callback.
3. Remove the old direct `registerExternalTools` calls (if any remain) in individual tool files — registration flows through `register.ts` only.

### Acceptance criteria
- Zero `assistant/` imports in all 5 tool files.
- LLM still sees meet tools in its tool manifest after daemon start (verify by running `bun test` against the tool-registry integration test).
- `bunx tsc --noEmit` clean.

## PR 15: Convert `routes/meet-internal.ts` to host-based handler

### Depends on
PR 8

### Branch
skill-isolation/pr-15-migrate-meet-route

### Title
refactor(meet-join): migrate meet-internal route to SkillHost

### Files
- `skills/meet-join/routes/meet-internal.ts`
- `skills/meet-join/register.ts` (route registration)

### Implementation steps
1. Refactor `handleMeetInternalEvents` and friends to accept `host: SkillHost` as an explicit parameter (or build a closure in `register.ts` that captures it). Replace all `assistant/` imports — auth helpers, identity constants, logger — with `host.*`.
2. Ensure `register.ts` passes the host to the route registration via `host.registries.registerSkillRoute({ pattern, methods, handler: (req, match) => handleMeetInternalEvents(host, req, match[1]!) })`.

### Acceptance criteria
- Zero `assistant/` imports in `routes/meet-internal.ts`.
- POST to `/api/skills/meet/<meetingId>/events` still auths and dispatches correctly in an integration test.
- `bunx tsc --noEmit` clean.

## PR 16: Add `buildTestHost()` helper + migrate all meet-join tests to use it

### Depends on
PR 8

### Branch
skill-isolation/pr-16-test-host-helper

### Title
test(meet-join): add buildTestHost helper and migrate tests off direct assistant imports

### Files
- `skills/meet-join/__tests__/build-test-host.ts` (new)
- `skills/meet-join/__tests__/*.test.ts` (all test files in the skill)

### Implementation steps
1. Create `skills/meet-join/__tests__/build-test-host.ts` exporting `buildTestHost(overrides: Partial<SkillHost> = {}): SkillHost` that returns a shallow stub of `SkillHost` with no-op defaults + passable mocks (`logger.get` → console wrapper, `events.publish` → jest.fn, etc.). Model it on similar test-host helpers in the codebase if any exist.
2. Migrate each meet-join test file to use `buildTestHost({ ... })` instead of directly importing/mocking `assistant/src/...` modules. This unblocks the skill-side guard test (PR 19) which forbids `assistant/` imports even in test files.

### Acceptance criteria
- Every meet-join `.test.ts` file has zero `from "../../../assistant/..."` imports.
- `bun test skills/meet-join/` passes.

## PR 17: Convert `session-manager.ts` (hub) to host-based

### Depends on
PR 9, PR 10, PR 11, PR 12, PR 13, PR 14, PR 15

### Branch
skill-isolation/pr-17-migrate-session-manager

### Title
refactor(meet-join): migrate session-manager to SkillHost + sub-module registry

### Files
- `skills/meet-join/daemon/session-manager.ts`
- `skills/meet-join/register.ts`

### Implementation steps
1. Convert `MeetSessionManager` from a class with 14 top-level `assistant/` imports into `createMeetSessionManager(host: SkillHost): MeetSessionManager`. Every `getConfig`, `getAssistantName`, `addMessage`, `getConfiguredProvider`/`userMessage`/`extractToolUse`/`createTimeout`, `wakeAgentForOpportunity`, `DAEMON_INTERNAL_ASSISTANT_ID`, `DaemonRuntimeMode`/`getDaemonRuntimeMode`, `getProviderKeyAsync`, `getTtsProvider`/`resolveTtsConfig`/`TtsProvider`, `getLogger`, `getWorkspaceDir` → `host.*` equivalent.
2. Where the session-manager instantiates sub-modules (audio-ingest, speaker-resolver, tts-bridge, docker-runner, observers), use the `getSubModule("name")(host)` lookup from the `modules-registry` introduced in PR 8. This is why the registry exists — avoids hard-coded imports and keeps session-manager decoupled from each sub-module's factory identity.
3. Update `register.ts` to construct the session manager via the same factory and pass it into its tool/route handlers (session-manager is the glue).

### Acceptance criteria
- Zero `assistant/` imports in `session-manager.ts`.
- Real Meet session still works end-to-end (`vellum up`, join a live meeting, speak, chat, leave). This is the critical integration test — spend time verifying.
- `bunx tsc --noEmit` clean.
- Existing session-manager unit tests pass with `buildTestHost`.

## PR 18: Remove compat shims; finalize register.ts

### Depends on
PR 17, PR 14, PR 15, PR 16

### Branch
skill-isolation/pr-18-cleanup-compat

### Title
refactor(meet-join): remove compat singletons and unused adapters after full host migration

### Files
- `skills/meet-join/register.ts`
- `skills/meet-join/daemon/modules-registry.ts`
- Any `skills/meet-join/daemon/*.ts` that still exports a backward-compat singleton

### Implementation steps
1. Walk `skills/meet-join/` for any lingering backward-compat module-level singletons, unused re-exports, or dead code from the migration. Delete.
2. Simplify `register.ts` to the final shape — no dual paths.
3. If `modules-registry.ts` is no longer needed (all consumers go through `register.ts` directly), delete it. Otherwise keep it if it meaningfully simplifies the wiring.

### Acceptance criteria
- `grep -rE 'from "[^"]*(\.\./)+assistant/'` returns zero matches in `skills/meet-join/`.
- Real Meet session still works end-to-end.
- `bunx tsc --noEmit` clean.

## PR 19: Add skill-side boundary guard test

### Depends on
PR 18

### Branch
skill-isolation/pr-19-skill-side-guard

### Title
test: guard that skills/ does not import from assistant/

### Files
- `assistant/src/__tests__/skill-boundary-guard.test.ts`

### Implementation steps
1. Create a new guard test modeled on `assistant/src/__tests__/gateway-only-guard.test.ts` and `no-direct-anthropic-sdk-imports.test.ts`. Use `git grep` or the in-repo AST scanner to assert that no TypeScript file anywhere under `skills/` contains an import path of the form `(../)+assistant/`.
2. The test has two assertions — one for `skills/` → `assistant/` (active now, after PR 18), and one for `assistant/` → `skills/` (marked `test.todo("...", () => {})` with a note that it will be activated in PR 34 after the bootstrap is removed). CLAUDE.md's "no normally-failing tests" rule forbids leaving an always-red assertion.

### Acceptance criteria
- `bun test assistant/src/__tests__/skill-boundary-guard.test.ts` passes.
- The `test.todo` assertion is present (visible in test reporter output) but does not fail.
- If a developer adds a new `assistant/` import to `skills/`, the test fails with a clear message pointing at the offending file.

## PR 20: Add skill IPC server (`skill-server.ts`) + socket-path helper

### Depends on
PR 19

### Branch
skill-isolation/pr-20-skill-ipc-server

### Title
feat(daemon): add skill IPC server at assistant-skill.sock

### Files
- `assistant/src/ipc/skill-server.ts`
- `assistant/src/ipc/skill-socket-path.ts`
- `assistant/src/ipc/skill-routes/index.ts` (new, empty route registry)
- `assistant/src/daemon/server.ts` (wire up start/stop)

### Implementation steps
1. Create `assistant/src/ipc/skill-socket-path.ts` modeled on `socket-path.ts` but resolving `<workspaceDir>/assistant-skill.sock` (with the same macOS-fallback chain).
2. Create `assistant/src/ipc/skill-server.ts` modeled on `cli-server.ts`. Same JSON-lines protocol (`{id, method, params?}` → `{id, result|error}`). Empty route registry initially.
3. Wire `SkillIpcServer` into `assistant/src/daemon/server.ts` alongside `CliIpcServer` — start with the daemon, stop on shutdown.
4. Unit test: start the server on a tmp socket path, connect with a raw client, verify the handshake echoes a `hello` frame if any. Model on `cli-server`'s test harness if one exists.

### Acceptance criteria
- Daemon starts with a new `assistant-skill.sock` file in the workspace directory.
- `bun test assistant/src/ipc/__tests__/skill-server.test.ts` passes.
- No functional change yet (no routes are defined, no skills connect).

## PR 21: Add `host.log`, `host.config.*`, `host.identity.*`, `host.platform.*` routes

### Depends on
PR 20

### Branch
skill-isolation/pr-21-host-core-routes

### Title
feat(daemon): add core host IPC routes (log, config, identity, platform)

### Files
- `assistant/src/ipc/skill-routes/log.ts`
- `assistant/src/ipc/skill-routes/config.ts`
- `assistant/src/ipc/skill-routes/identity.ts`
- `assistant/src/ipc/skill-routes/platform.ts`
- `assistant/src/ipc/skill-routes/index.ts` (register)
- test files for each

### Implementation steps
1. Implement route handlers for `host.log`, `host.config.getSection`, `host.config.isFeatureFlagEnabled`, `host.identity.getAssistantName`, `host.identity.getInternalAssistantId`, `host.platform.workspaceDir`, `host.platform.vellumRoot`, `host.platform.runtimeMode`. Each delegates to the existing daemon module (same as `DaemonSkillHost`).
2. Register all in `skill-routes/index.ts`.
3. Unit tests for each route.

### Acceptance criteria
- `bun test assistant/src/ipc/skill-routes/__tests__/` passes.
- Each route validates params, returns the right shape, handles errors.

## PR 22: Add `host.memory.*` + `host.providers.*` routes

### Depends on
PR 20

### Branch
skill-isolation/pr-22-host-memory-providers-routes

### Title
feat(daemon): add memory and provider host IPC routes

### Files
- `assistant/src/ipc/skill-routes/memory.ts`
- `assistant/src/ipc/skill-routes/providers.ts`
- `assistant/src/ipc/skill-routes/index.ts`
- tests

### Implementation steps
1. Add `host.memory.addMessage`, `host.memory.wakeAgentForOpportunity`.
2. Add `host.providers.llm.complete`, `host.providers.stt.listProviderIds`, `host.providers.stt.supportsBoundary`, `host.providers.tts.resolveConfig`, `host.providers.tts.get` (returns a handle/id only — actual synthesis is done in-skill), `host.providers.secureKeys.getProviderKey`.
3. Register routes and add tests.

### Acceptance criteria
- Unit tests pass.
- Memory/provider behavior via IPC matches direct-call behavior.

## PR 23: Add `host.events.*` routes (publish + long-lived subscribe)

### Depends on
PR 20

### Branch
skill-isolation/pr-23-host-events-routes

### Title
feat(daemon): add host IPC event routes including long-lived subscribe stream

### Files
- `assistant/src/ipc/skill-routes/events.ts`
- `assistant/src/ipc/skill-routes/index.ts`
- tests

### Implementation steps
1. `host.events.publish` — one-shot RPC that forwards an `AssistantEvent` to `assistantEventHub`.
2. `host.events.subscribe` — long-lived stream. The client sends a subscribe frame with a filter; the server streams matching events back as `event.delivery` frames on the same socket until the client sends `event.subscribe.close` or disconnects. Clean shutdown on daemon stop.
3. Tests: publish round-trip, subscribe filter match/non-match, cleanup on disconnect.

### Acceptance criteria
- Publishing via IPC ends up on the daemon's event hub exactly as in-process publish would.
- Subscribe delivers filtered events; disconnect correctly frees hub subscription.

## PR 24: Add `host.registries.*` routes

### Depends on
PR 20

### Branch
skill-isolation/pr-24-host-registries-routes

### Title
feat(daemon): add host registry IPC routes (register_tools, register_skill_route, shutdown_hook, session reporting)

### Files
- `assistant/src/ipc/skill-routes/registries.ts`
- `assistant/src/ipc/skill-routes/index.ts`
- tests

### Implementation steps
1. `host.registries.register_tools` — accepts a serialized tool manifest (name, description, input_schema, risk, category) and installs proxy tools into the daemon's tool registry. Each proxy tool's `execute` function round-trips `skill.dispatch_tool` over the IPC socket (see PR 28 which plumbs the dispatch path).
2. `host.registries.register_skill_route` — accepts a pattern regex source + HTTP method list; installs a proxy route that forwards to the remote skill via `skill.dispatch_route`.
3. `host.registries.register_shutdown_hook` — registers a hook that, on daemon shutdown, sends `skill.shutdown` to the skill process.
4. `host.registries.report_session_started` / `host.registries.report_session_ended` — updates the `MeetHostSupervisor` active-session counter for idle-timeout tracking.
5. Tests for each.

### Acceptance criteria
- Registering a tool via IPC makes it visible in `initializeTools()` output.
- Registering a route via IPC routes matching HTTP requests to `skill.dispatch_route`.
- Shutdown hook fires on daemon shutdown.

## PR 25: Add `SkillHostClient` in `packages/skill-host-contracts/`

### Depends on
PR 21, PR 22, PR 23, PR 24

### Branch
skill-isolation/pr-25-skill-host-client

### Title
feat(skill-host-contracts): add IPC-backed SkillHostClient

### Files
- `packages/skill-host-contracts/src/client.ts`
- `packages/skill-host-contracts/src/index.ts`
- `packages/skill-host-contracts/__tests__/client.test.ts`

### Implementation steps
1. Add `SkillHostClient` — implements the `SkillHost` interface by sending JSON-lines RPCs over a Unix domain socket. Connection URL is passed to its constructor: `new SkillHostClient({ socketPath, skillId })`.
2. Every method maps 1:1 to a `host.*` IPC route. Long-lived streams (`events.subscribe`) return a `Subscription` object that cleans up on unsubscribe.
3. Implement request/response correlation (by `id` field), error mapping (remote errors → thrown Error), automatic reconnect with backoff (optional, at least document it).
4. Test: spin up `SkillIpcServer` on a tmp socket with the Phase-2 routes, construct `SkillHostClient` against it, exercise each method path; verify behavioral parity with `DaemonSkillHost` from PR 7.

### Acceptance criteria
- All `SkillHost` methods work against the IPC server.
- `bun test packages/skill-host-contracts/__tests__/client.test.ts` passes.
- Parity test confirms `SkillHostClient` and `DaemonSkillHost` produce identical observable behavior for representative operations (publish event, register tool, etc.).

## PR 26: Add manifest generator script

### Depends on
PR 8

### Branch
skill-isolation/pr-26-manifest-generator

### Title
feat(meet-join): add emit-manifest script

### Files
- `skills/meet-join/scripts/emit-manifest.ts`
- `skills/meet-join/package.json` (add `scripts.emit-manifest`)
- `skills/meet-join/__tests__/emit-manifest.test.ts`

### Implementation steps
1. Create `skills/meet-join/scripts/emit-manifest.ts`. It constructs a manifest-collecting `SkillHost` — a stub where `registries.registerTools`, `registries.registerSkillRoute`, `registries.registerShutdownHook` capture inputs into an in-memory collector; all other methods are safe no-ops or throw if unexpectedly called.
2. Run `register(collectorHost)` against it.
3. Serialize the collected tools (name, description, input_schema, risk, category), route patterns + methods, shutdown-hook names into a JSON manifest. Embed a source-tree content hash (hash over all `.ts` files under `skills/meet-join/`).
4. Write to a path passed as `--output <path>` (default: `skills/meet-join/manifest.json` for dev; CI passes the install-bundle path).
5. Add a package.json `scripts.emit-manifest` that runs via `bun run`.
6. Test: run the script with a tmp output path; assert the manifest JSON validates against a schema and matches the tools registered by `register.ts`.

### Acceptance criteria
- `bun run --cwd skills/meet-join emit-manifest -- --output /tmp/test-manifest.json` produces a valid manifest.
- Manifest tool count matches the number of tools `register.ts` wires up.
- Content hash is stable across runs (deterministic).

## PR 27: Add `MeetHostSupervisor` with lazy spawn + session counter + idle timeout

### Depends on
PR 20

### Branch
skill-isolation/pr-27-meet-host-supervisor

### Title
feat(daemon): add MeetHostSupervisor for lazy meet-host spawn lifecycle

### Files
- `assistant/src/daemon/meet-host-supervisor.ts`
- `assistant/src/daemon/__tests__/meet-host-supervisor.test.ts`

### Implementation steps
1. Create `MeetHostSupervisor` with these responsibilities:
   - `ensureRunning()` — if process not running, spawn `bun run <installed-skill-path>/register.ts --ipc=<socket> --skill-id=meet-join`. Use `child_process.spawn`. Cache an in-flight promise so concurrent callers await the same spawn.
   - Handshake — wait for the skill to connect to `assistant-skill.sock` and send a `host.registries.register_tools` or explicit `ready` frame. Verify handshake's reported source-tree hash matches the manifest's hash; if not, crash the spawn with a clear error.
   - Active-session counter — increment on `host.registries.report_session_started`, decrement on `report_session_ended`.
   - Idle timer — when counter reaches zero, start a 5-minute timer (configurable via `services.meet.host.idle_timeout_ms`). On expiry, send `skill.shutdown`, wait for graceful exit, then SIGTERM/SIGKILL as fallback.
   - Crash detection — supervise the child process; on unexpected exit, null out the handle; `ensureRunning()` re-spawns on next call.
2. Resolve the installed-skill-path via platform-mode: in Docker mode `/app/skills/meet-join`, bare-metal `<install-dir>/skills/meet-join`.
3. Tests: spawn/shutdown, idle timeout, spawn-race mutex, hash-mismatch rejection.

### Acceptance criteria
- `bun test assistant/src/daemon/__tests__/meet-host-supervisor.test.ts` passes.
- Supervisor shuts down child cleanly on daemon stop.
- Hash mismatch produces a clear user-facing error (not a silent spawn-loop).

## PR 28: Add proxy tool/route registrations reading `manifest.json` + dispatch path

### Depends on
PR 25, PR 26, PR 27

### Branch
skill-isolation/pr-28-manifest-proxy-registrations

### Title
feat(daemon): register meet-join tools and routes from manifest with lazy IPC dispatch

### Files
- `assistant/src/daemon/meet-manifest-loader.ts` (new)
- `assistant/src/daemon/external-skills-bootstrap.ts` (swap in-process path for lazy path behind a feature flag)
- tests

### Implementation steps
1. Create `meet-manifest-loader.ts` that at daemon startup (if `meet` feature flag enabled): reads the shipped `manifest.json` from the installed skill dir; for each tool entry, registers a proxy `Tool` whose `execute` calls `supervisor.ensureRunning()` then sends `skill.dispatch_tool` over IPC; for each route entry, registers a proxy `SkillRoute` whose `handler` does the same via `skill.dispatch_route`; registers the `report_session_*` shutdown hooks if declared.
2. Add a temporary flag `services.meet.host.lazy_external = false` default (we do not flip default yet — that happens in PR 32). When true, the loader runs; when false, the existing in-process `registerMeet(createDaemonSkillHost())` runs (from PR 8).
3. Tests: when the flag is true + manifest is present + supervisor stubbed, proxy tool invocation triggers supervisor.ensureRunning().

### Acceptance criteria
- Flag on + stubbed supervisor: proxy tools invoke dispatch path.
- Flag off: in-process path behaves identically to pre-PR-28.
- Meet feature still works in both modes (verify end-to-end with flag on against a real meet-host spawn in the subsequent manual test).

## PR 29: Ship bun runtime + skill source + manifest in the Docker image

### Depends on
PR 26

### Branch
skill-isolation/pr-29-docker-ship-skill

### Title
build(docker): ship bun runtime + skills/meet-join source + manifest

### Files
- `assistant/Dockerfile`
- `.dockerignore` (repo root)
- possibly `scripts/` to run `emit-manifest` as a build step

### Implementation steps
1. In `assistant/Dockerfile`, add a build stage that `RUN`s `bun run --cwd skills/meet-join emit-manifest --output /app/skills/meet-join/manifest.json`. Ensure `skills/meet-join/` source files and deps are in the build context (`.dockerignore` allowlist).
2. Copy a standalone `bun` binary into the runtime stage at a known path (e.g. `/usr/local/bin/bun`) — matching the Bun version already pinned in `.tool-versions`.
3. Copy `skills/meet-join/` source tree + manifest into `/app/skills/meet-join/` in the runtime stage.
4. Verify `skills/meet-join/node_modules/` or a deduped install is available so `bun run` can resolve skill dependencies at runtime.

### Acceptance criteria
- `docker build` succeeds end-to-end.
- `docker run ... bun run /app/skills/meet-join/register.ts --help` works inside the container (smoke).
- `docker run ... test -f /app/skills/meet-join/manifest.json` succeeds.

## PR 30: Update CI workflows for manifest emit + Docker build

### Depends on
PR 29

### Branch
skill-isolation/pr-30-ci-manifest

### Title
ci: emit meet-join manifest and include skill source in release artifacts

### Files
- `.github/workflows/*.yml` (specifically Docker build + release workflows)

### Implementation steps
1. Add a CI step that runs `bun run --cwd skills/meet-join emit-manifest` before Docker build and any release-artifact packaging.
2. For non-Docker release artifacts (macOS `.app`, see PR 31 — coordinate), ensure the skill source tree and manifest are copied into the artifact.
3. Pin any new `uses:` steps to a 40-char SHA with trailing `# vX.Y.Z` comment per CLAUDE.md.

### Acceptance criteria
- CI passes on the feature branch.
- Release workflow produces artifacts containing the manifest + skill source.

## PR 31: Ship bun runtime + skill source + manifest in macOS `.app`

### Depends on
PR 26

### Branch
skill-isolation/pr-31-macos-ship-skill

### Title
build(macos): bundle bun runtime + meet-join source + manifest in the .app Resources

### Files
- `clients/macos/build.sh` (or equivalent packaging script)
- `clients/macos/Package.swift` if relevant
- `clients/macos/Resources/` layout docs

### Implementation steps
1. In `clients/macos/build.sh`, copy a standalone `bun` binary into `App.app/Contents/Resources/bun` (matching `.tool-versions`). Ensure the binary is signed + notarized as part of the existing signing pipeline.
2. Copy `skills/meet-join/` source tree into `App.app/Contents/Resources/skills/meet-join/` (including the manifest produced by `emit-manifest`).
3. Update daemon's skill-path resolution to find these files at runtime. Platform helper in `assistant/src/util/platform.ts` or a new helper.

### Acceptance criteria
- Local dev build of the `.app` contains `Resources/bun` and `Resources/skills/meet-join/manifest.json`.
- Notarization passes (verify locally or in a staging CI run).
- Assistant running from the `.app` can find the shipped skill path.

## PR 32: Flip `services.meet.host.lazy_external` default to `true`

### Depends on
PR 25, PR 28, PR 29, PR 30, PR 31

### Branch
skill-isolation/pr-32-flip-lazy-default

### Title
feat(daemon): default meet-host to lazy external process

### Files
- `assistant/src/config/defaults.ts` (or wherever the flag default lives)

### Implementation steps
1. Flip the default of `services.meet.host.lazy_external` from `false` to `true`.
2. Sanity-check in both Docker mode and bare-metal mode that the lazy path works end-to-end with real Meet sessions.

### Acceptance criteria
- Default-config daemon starts, does NOT spawn meet-host at boot.
- First `meet_join` tool call cold-starts meet-host and completes the join within 2s.
- Real Meet session end-to-end (bare-metal + Docker mode).
- Idle timeout observed after 5 minutes of no active sessions.

## PR 33: Delete `external-skills-bootstrap.ts` + remove in-process fallback

### Depends on
PR 32

### Branch
skill-isolation/pr-33-delete-bootstrap

### Title
refactor(daemon): delete external-skills-bootstrap.ts; lazy external path is sole entry

### Files
- Delete: `assistant/src/daemon/external-skills-bootstrap.ts`
- Delete: the in-process fallback branch in the daemon startup flow
- `assistant/src/daemon/server.ts` (remove import of deleted module)
- `CLAUDE.md` (remove the Skill Isolation narrow-exception paragraph)
- `skills/meet-join/AGENTS.md` (remove the matching exception paragraph)
- Remove the now-unused `services.meet.host.lazy_external` flag (always-on behavior)

### Implementation steps
1. Delete `assistant/src/daemon/external-skills-bootstrap.ts` and the in-process fallback code path that PR 28 introduced. Daemon starts meet-join only via the manifest loader + supervisor path.
2. Remove the feature flag `services.meet.host.lazy_external` from defaults and its reference in `meet-manifest-loader.ts`.
3. Update `CLAUDE.md`'s "Skill Isolation" section to remove the sanctioned-exception paragraph.
4. Update `skills/meet-join/AGENTS.md` to match.
5. Verify no other file still references `external-skills-bootstrap`.

### Acceptance criteria
- Daemon starts cleanly with no reference to `external-skills-bootstrap`.
- Real Meet session works end-to-end (bare-metal + Docker).
- `grep -r external-skills-bootstrap` returns zero matches in the repo.

## PR 34: Flip assistant-side skill-boundary guard test from `test.todo` to `test`

### Depends on
PR 33

### Branch
skill-isolation/pr-34-enable-full-guard

### Title
test: enable bidirectional skill-boundary guard assertion

### Files
- `assistant/src/__tests__/skill-boundary-guard.test.ts`

### Implementation steps
1. In `assistant/src/__tests__/skill-boundary-guard.test.ts`, convert the existing `test.todo` placeholder (asserting that no file under `assistant/src/` imports from `skills/`) into an active `test(...)` with a `git grep` assertion asserting zero matches for any TypeScript file under `assistant/src/` importing via `(../)+skills/`.
2. Run the test locally; confirm it passes after PR 33's deletion.
3. Adjust any exemption handling (e.g. `/__tests__/` carve-out) per final codebase state.

### Acceptance criteria
- `bun test assistant/src/__tests__/skill-boundary-guard.test.ts` passes both assertions.
- Adding a deliberate `from "../../../skills/meet-join/foo.js"` import to any `assistant/src/` file breaks the test with a clear message.
- CI passes.
