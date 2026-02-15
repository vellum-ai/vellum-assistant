# Refactor Baseline Snapshot

**Commit:** `043fcc107cb7d3d4c39d4894cd644649046d390b`
**Branch:** `main` (clean, up to date with `origin/main`)
**Date:** 2026-02-15

---

## Architecture Metrics

### Swift ObservableObject classes (16)

```
clients/shared/IPC/DaemonClient.swift
clients/macos/vellum-assistant/ComputerUse/Session.swift
clients/macos/vellum-assistant/Features/Settings/SkillsSettingsView.swift
clients/macos/vellum-assistant/Features/MainWindow/Panels/SkillsManager.swift
clients/shared/Features/Chat/ChatViewModel.swift
clients/macos/vellum-assistant/Features/Surfaces/SurfaceManager.swift
clients/macos/vellum-assistant/Features/MainWindow/ThreadManager.swift
clients/macos/vellum-assistant/Logging/TraceStore.swift
clients/macos/vellum-assistant/ComputerUse/TextSession.swift
clients/macos/vellum-assistant/Features/MainWindow/ZoomManager.swift
clients/macos/vellum-assistant/Features/Voice/VoiceTranscriptionWindow.swift
clients/macos/vellum-assistant/Features/Sharing/BundleConfirmationViewModel.swift
clients/macos/vellum-assistant/Ambient/AmbientAgent.swift
clients/macos/vellum-assistant/Features/Session/TextResponseWindow.swift
clients/macos/vellum-assistant/Ambient/KnowledgeStore.swift
clients/macos/vellum-assistant/Ambient/InsightStore.swift
```

### @Observable types (6)

```
clients/macos/vellum-assistant/Features/Onboarding/Interview/ProfileExtractor.swift
clients/macos/vellum-assistant/Features/Onboarding/FirstMeeting/FirstMeetingIntroductionViewModel.swift
clients/macos/vellum-assistant/Features/Onboarding/Interview/InterviewViewModel.swift
clients/macos/vellum-assistant/Features/Onboarding/FirstMeeting/JITPermissionManager.swift
clients/macos/vellum-assistant/Features/Onboarding/OnboardingState.swift
clients/macos/vellum-assistant/Features/Onboarding/Hatch/HatchViewModel.swift
```

### High-Churn Module Line Counts

| Module | Lines |
|--------|-------|
| `assistant/src/daemon/session.ts` | 2,092 |
| `assistant/src/daemon/handlers.ts` | 1,997 |
| `assistant/src/memory/retriever.ts` | 1,817 |
| `assistant/src/tools/swarm/delegate.ts` | 239 |
| `assistant/src/swarm/orchestrator.ts` | 235 |
| `assistant/src/runtime/run-orchestrator.ts` | 194 |
| `clients/macos/vellum-assistant/App/AppDelegate.swift` | 1,374 |
| `clients/shared/Features/Chat/ChatViewModel.swift` | 1,436 |
| `clients/macos/vellum-assistant/Features/Surfaces/SurfaceManager.swift` | 408 |
| `clients/macos/vellum-assistant/Features/MainWindow/ThreadManager.swift` | 225 |

---

## Validation Results

### Assistant — Lint (`bun run lint`)

**Status: FAIL** (27 pre-existing errors)

Errors are across test files and one source file — mostly `@typescript-eslint/no-explicit-any` and `no-unused-vars` in tests. No errors in core source outside `memory/jobs-worker.ts` and `tools/terminal/evaluate-typescript.ts`.

### Assistant — Tests (`EXCLUDE_EXPERIMENTAL=true bun run test`)

**Status: PARTIAL** — All tests pass until Bun v1.3.9 crashes on `memory-recall-quality.test.ts` with a C++ exception (runtime bug, not code). Every test file before the crash: all pass.

### Assistant — Typecheck (`bun run typecheck`)

**Status: MISSING** — No `typecheck` script defined in `assistant/package.json`. Will be added in PR 2.

### Gateway — Typecheck (`bun run typecheck`)

**Status: PASS**

### Gateway — Tests (`bun run test`)

**Status: PASS** (78 tests, 0 failures)

### Swift — Build/Lint/Test

**Status: NOT RUN** — requires Xcode environment; recorded for manual verification.

---

## Known Pain Points

1. **`session.ts` is 2,092 lines** — conflict gate, dynamic profile injection, queue management, and runtime message assembly are all co-located in one class.
2. **Side-effect tool registration** — memory, credentials, and timer tools register via import side effects, making dead-code analysis unreliable.
3. **No `typecheck` script in assistant** — validation requires manual `tsc --noEmit` invocation; easy to skip.
4. **27 pre-existing lint errors** — mostly in test files; lint is not gating CI merges currently.
5. **`ObservableObject` dominates** — 16 types vs 6 `@Observable`; Observation adoption limited to onboarding flow.
6. **Duplicated settings state** — `SettingsView` and `SettingsPanel` manage settings independently.
7. **Bun v1.3.9 crash in memory-recall-quality tests** — intermittent runtime-level crash blocks full test suite completion.
