# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A native macOS menu bar app that controls your Mac via accessibility APIs and CGEvent input injection, powered by Claude via the Anthropic Messages API with tool use. It lives as a sparkles icon in the menu bar — users type a task (or hold Fn for voice), and the agent executes it step-by-step.

## Build & Test

Single build script: `./build.sh` wraps SwiftPM → `.app` bundle → codesign. No Xcode project needed.

```bash
# Build debug .app bundle (→ dist/vellum-assistant.app)
./build.sh

# Build + launch
./build.sh run

# Build release
./build.sh release

# Run all tests
./build.sh test

# Run a single test
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --filter SessionTests/testHappyPath_completesInThreeSteps

# Watch logs from a running instance
log stream --predicate 'subsystem == "com.vellum.vellum-assistant"' --level debug
```

## Architecture

### Session Loop (`Session.swift`)

The core orchestration cycle runs per-task in `ComputerUseSession` (`@MainActor`):

1. **PERCEIVE** — enumerate the AX tree of the focused window (`AccessibilityTree.swift`); also captures a screenshot alongside; falls back to screenshot-only if no AX tree. Computes `AXTreeDiff` between steps. Enumerates secondary windows for cross-app awareness.
2. **INFER** — send AX tree + screenshot + previous AX tree + diff + task + action history to the daemon via IPC (`DaemonClient`); daemon calls Claude and returns exactly one tool call per turn.
3. **VERIFY** — safety checks: sensitive data, destructive keys, loop detection (3 identical consecutive actions), step limits, system menu bar exclusion (`ActionVerifier`).
4. **EXECUTE** — inject mouse/keyboard events via CGEvent (`ActionExecutor`). Text input uses clipboard-paste (Cmd+V) with save/restore.
5. **WAIT** — adaptive delay: polls AX tree for changes instead of fixed sleep, returns early when UI settles.

### Dependency Injection

All session dependencies are protocol-based for testability:
- `AccessibilityTreeProviding` — AX enumeration (impl: `AccessibilityTreeEnumerator`)
- `ScreenCaptureProviding` — screenshots (impl: `ScreenCapture`)
- `ActionExecuting` — CGEvent injection (impl: `ActionExecutor`)

Tests use `Mock*` versions defined in `SessionTests.swift`. Test pattern: `@MainActor func testX() async`.

### IPC Layer (`IPC/`)

All inference (both computer-use sessions and ambient analysis) goes through daemon IPC:
- `DaemonClient` — `@MainActor`, Unix domain socket (`~/.vellum/vellum.sock`), auto-reconnect, ping/pong keepalive, `AsyncStream<ServerMessage>`
- `IPCMessages.swift` — Codable structs mirroring `ipc-protocol.ts`: `cu_session_create`, `cu_observation`, `cu_action`, `cu_complete`, `cu_error`, `ambient_analyze`, etc.

`AnthropicClient` is the shared HTTP client with retry logic (exponential backoff for 429/5xx). Still used by `KnowledgeCron` for local insight analysis (direct Haiku calls, not through daemon).

### Ambient Agent (`Ambient/`)

A background screen-watching system that runs alongside the manual session loop:
- `AmbientAgent` — orchestrates periodic capture → OCR → analyze cycles via daemon IPC (configurable interval, default 30s)
- `AmbientAnalyzer.swift` — type definitions only (`AmbientDecision`, `AmbientAnalysisResult`); analysis logic lives in the daemon
- `KnowledgeStore` — persists observations as JSON in Application Support (max 500 entries)
- `KnowledgeCron` — triggers insight analysis after every N observations; generates higher-level insights via `InsightStore`

### Voice Input

`VoiceInputManager` — hold Fn (or Ctrl, configurable) for speech-to-text via `SFSpeechRecognizer`. Shows `VoiceTranscriptionWindow` during recording.

### App Lifecycle

`AppDelegate` sets up: NSStatusItem with NSPopover, global hotkey (Cmd+Shift+G via HotKey package), global Escape monitor, voice input, ambient agent, and onboarding flow. `VellumAssistantApp` is the `@main` entry point with `@NSApplicationDelegateAdaptor`.

### Onboarding

`UI/Onboarding/` — multi-step flow (`OnboardingFlowView` → `OnboardingState`) covering wake-up animation, naming, permissions (screen recording, microphone), Fn key setup, and an alive-check step. Shown on first launch; skip with `--skip-onboarding` in debug.

## Key Constraints

- **LSUIElement app** — no dock icon; uses `.accessory` activation policy. Must temporarily switch to `.regular` when showing Settings window.
- **`Bundle.main.bundleIdentifier` is nil** in SPM builds. All `os.Logger` instances use hardcoded fallback `"com.vellum.vellum-assistant"`.
- **Adding .swift files**: Auto-picked up by SPM. No manual project file edits needed.
- **Chrome special handling** — `ChromeAccessibilityHelper` detects when Chrome's AX tree lacks web content and auto-restarts Chrome with `--force-renderer-accessibility`.
- **Popover close delay** — 300ms initial delay before session starts to let the popover close and target app regain focus.
- **SessionState enum** must stay in sync with `SessionOverlayView` pattern matching.

## Permissions

Requires Accessibility, Screen Recording, and Microphone permissions (System Settings > Privacy & Security). `PermissionManager` handles checking/prompting. API key stored in Keychain via `APIKeyManager`.

## Data Storage

- Session logs: `~/Library/Application Support/vellum-assistant/logs/session-*.json`
- Knowledge store: `~/Library/Application Support/vellum-assistant/knowledge.json`
