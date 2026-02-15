# Refactor Plan — Closeout Report

**Plan:** `.private/plans/REFACTOR.md` (18 PRs across 5 phases)
**Completed:** 2026-02-15

---

## What Was Accomplished

### Phase 1: Baseline & Guardrails (PRs 1-3)

- Captured baseline metrics (line counts, type-check status, test counts)
- Standardized typecheck and test entrypoints across `assistant/` and `gateway/`
- Added dead-code inventory tooling (knip) and generated initial report

### Phase 2: Dead Code Removal (PRs 4-6)

- **Removed** low-risk dead TypeScript code in `assistant/` and `gateway/` identified by knip
- **Removed** low-risk dead Swift code and assets (images, unused views, stale extensions)
- **Preserved** memory regression coverage and split experimental test suite from stable suite

### Phase 3: Daemon Structural Refactors (PRs 7-12)

- **Introduced** declarative tool registry manifest (`tool-manifest.ts`) replacing side-effect registration
- **Converted** memory tools, credentials tools, and timer tools to explicit manifest-based registration
- **Extracted** session conflict gate and dynamic profile helpers from monolithic `session.ts`
- **Extracted** session queue manager and runtime message assembly helpers
- **Hardened** swarm tool-runtime-orchestrator boundaries with dedicated Claude Code backend module

### Phase 4: macOS App State Refactors (PRs 13-17)

- **Centralized** app-lifetime services via `AppServices` singleton container
- **Unified** settings business logic with shared `SettingsStore` (eliminating duplicated state between `SettingsView` and `SettingsPanel`)
- **Extracted** `ThreadSessionRestorer` from `ThreadManager` with testable delegate protocol (7 new tests)
- **Introduced** `MainWindowState` for explicit cross-view UI state ownership
- **Migrated** low-risk types (`ZoomManager`, `ConversationInputState`, `BundleConfirmationViewModel`) to Swift Observation `@Observable` macro

### Phase 5: Final Cleanup (PR 18)

- **Updated** `ARCHITECTURE.md` with new macOS app state architecture section
- **Final dead code scan** confirmed minimal remaining dead code after PRs 4-5
- This closeout report

---

## Before/After Metrics

| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| ObservableObject classes | 17 | 14 | -3 (migrated to @Observable) |
| @Observable types | 6 | 9 | +3 |
| `session.ts` line count | 2,092 | ~1,400 | -33% (extracted to 4 helper modules) |
| Side-effect tool registrations | 3 modules | 0 | All converted to declarative manifest |
| Duplicated settings state surfaces | 2 | 1 (shared SettingsStore) | Unified |
| Swift test count | 28 | 35 | +7 (ThreadSessionRestorer tests) |
| Typecheck script (assistant) | Missing | `bun run typecheck` | Added |

---

## What Was Removed

| Category | Examples | PRs |
|----------|----------|-----|
| Dead TS exports | Unused types, unreferenced functions, stale re-exports | 4 |
| Dead Swift code | Unused views, stale extensions, unused asset catalogs | 5 |
| Duplicated state | Settings properties duplicated between SettingsView and SettingsPanel | 14 |
| Side-effect registration | `register*Tools()` functions that mutated global state at import time | 7, 8, 9 |

---

## What Was Centralized

| Before | After | PR |
|--------|-------|-----|
| Services scattered across AppDelegate properties | `AppServices` singleton container | 13 |
| Settings state duplicated in two views | Shared `SettingsStore` ObservableObject | 14 |
| Thread lifecycle + session restoration in one class | `ThreadManager` (CRUD) + `ThreadSessionRestorer` (daemon comms) | 15 |
| UI state as `@State` in MainWindowView | `MainWindowState` ObservableObject | 16 |
| Tool registration via side-effect imports | Declarative `tool-manifest.ts` with explicit registration | 7-9 |
| Session helpers inline in `session.ts` | `session-conflict-gate.ts`, `session-profile.ts`, `session-queue.ts`, `session-assembly.ts` | 10-11 |

---

## What Remains Intentionally Deferred

1. **`VoiceTranscriptionViewModel` -> `@Observable`**: Uses Combine `$`-prefixed publishers (`$contentHeight`, `$transcriptionText`) in `VoiceTranscriptionWindow.swift`. Migration requires rearchitecting the Combine pipeline first.

2. **Exported-but-file-scoped TS types**: Several types in the bundler module (`BundleResult`, `SignatureVerificationResult`, `ScanFinding`, `ScanResult`) are exported but only used as return types within their own files. These are legitimate API contracts — callers infer the type from the function signature.

3. **`USAGE_ACTORS` constant array**: Exported from `usage/actors.ts` but never imported. The `UsageActor` type union from the same file is used. The array was likely intended for runtime validation but isn't wired up yet.

4. **`print()` statements in Swift error paths**: Three `print()` calls in `AppDelegate`, `SessionLogger`, and `LogViewer` for error-path logging. Low-priority consistency improvement (should use `os.Logger`).

5. **Full `MainWindowView` -> `@Observable` migration**: `MainWindowState` currently uses `ObservableObject`/`@Published`. A future migration to `@Observable` would simplify consumer views further, but carries moderate risk due to the view's complexity.

---

## Next-Most-Valuable Refactor Candidates

1. **Split `AppDelegate` into focused coordinators** — At ~1,200 lines, `AppDelegate` handles window management, notification routing, IPC message dispatch, and session lifecycle. Extracting these into dedicated coordinator objects would improve testability and reduce cognitive load.

2. **Migrate `ChatViewModel` to `@Observable`** — The largest `ObservableObject` in the app. Would reduce boilerplate but requires careful testing of all reactive bindings.

3. **Extract daemon `session.ts` further** — Even after extracting conflict gate, profile, queue, and assembly helpers, `session.ts` remains the largest single file in the daemon. The core agent loop and tool execution pipeline could be further decomposed.

4. **Consolidate Swift IPC message dispatch** — `AppDelegate` has a large `switch` over `ServerMessage` cases. A handler-registry pattern (similar to the daemon's handler dispatch) would make message routing more maintainable.

5. **Introduce integration tests for `ThreadSessionRestorer`** — Unit tests cover the delegate protocol, but end-to-end tests with a mock `DaemonClient` would catch IPC serialization edge cases.
