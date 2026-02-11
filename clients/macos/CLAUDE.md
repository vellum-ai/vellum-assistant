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

## Swift Conventions

This section codifies the patterns already established in the codebase and community best practices. Follow these when writing or modifying Swift code.

### Tooling

- Swift tools version: **5.9** (Package.swift)
- Minimum deployment target: **macOS 14** (Sonoma)
- Build system: **SwiftPM** (no Xcode project). `./build.sh` wraps `swift build`.
- External dependencies: **only HotKey**. Do not add new dependencies without explicit approval.
- Test framework: **XCTest** with manual protocol mocks. No third-party mocking/testing frameworks.

### Naming (swift.org API Design Guidelines)

- **PascalCase** for types, protocols, enum cases. **camelCase** for everything else.
- Clarity at the point of use: names should be unambiguous when read at the call site.
- **Boolean** properties read as assertions: `isEmpty`, `isConnected`, `hasKey`, `canSubmit`, `shouldReconnect`.
- **Protocols** describing capabilities use `-able`/`-ible`/`-ing` suffixes: `ActionExecuting`, `ScreenCaptureProviding`, `AccessibilityTreeProviding`.
- **Mutating** methods use verb form (`sort()`); non-mutating counterparts use `-ed`/`-ing` (`sorted()`).
- **Factory** methods begin with `make`.
- **Argument labels** should form grammatical English phrases at the call site.
- **Acronyms**: uniform casing based on position — `utf8Bytes`, `HTTPSConnection`, `URLSession`.
- **Type suffixes** indicate purpose: `*Manager` (utilities), `*Protocol` (DI), `*Providing`/`*Executing` (DI), `*Error` (error enums), `*Message` (IPC types), `*Store` (persistence), `*View` (SwiftUI), `*Window` (NSWindow subclasses).

### Access Control

- Default to **`private`** for stored properties and helper methods.
- Use **`internal`** (implicit, no keyword) for module-visible API.
- **Never** use `public` or `open` — this is an app target, not a framework.
- Use **`private(set)`** for properties that are readable but not writable externally.
- Mark **all classes `final`** unless subclassing is explicitly required (only for NSWindow/NSObject subclasses).
- Access `internal` symbols in tests via `@testable import vellum_assistant`.

### Concurrency

- **`@MainActor` at the type level** on all `ObservableObject` classes. Do not annotate individual methods.
- **`async`/`await` exclusively** — no completion handlers, no Combine pipelines for async work. (Combine only for `ObservableObject` bridging via `.sink`.)
- **No `DispatchQueue`** for concurrency. Use `Task.sleep(nanoseconds:)` instead of `asyncAfter`. (Only acceptable for legacy AppKit interop in existing code.)
- **Store `Task` handles** and cancel them on cleanup:
  ```swift
  private var watchTask: Task<Void, Never>?
  func stop() { watchTask?.cancel(); watchTask = nil }
  ```
- **Check `Task.isCancelled`** in every long-running loop iteration.
- Prefer **structured concurrency** (`async let`, `TaskGroup`) over unstructured `Task { }` when work lifetime is bounded by the calling scope.
- Use **`AsyncStream.makeStream()`** (SE-0388 factory), not the closure-based initializer.
- Keep `@MainActor` work fast — offload heavy computation (image encoding, large tree diffing) to nonisolated async functions, then hop back for state updates.

### Error Handling

- **One error enum per domain** conforming to `LocalizedError`: `ExecutorError`, `InferenceError`, etc.
- Include **associated values** for context: `.apiError(statusCode: Int, body: String)`, `.unknownKey(String)`.
- Implement **`errorDescription`** on all error enums.
- Prefer **`throws` / `async throws`** over `Result` in async code.
- **`try?`** only for non-critical operations (IPC sends that can fail, sleep interruptions). Add a log call or comment explaining why failure is acceptable.
- **`try!`** only for programmer-invariant cases (known-constant URLs, system directories). Prefer `guard` + `fatalError("reason")` for clearer diagnostics.
- **Never** use empty `catch {}` blocks — at minimum log the error.
- Catch **specific error types before** the generic `catch`.
- Let **`CancellationError`** propagate naturally; don't catch it unless cleanup is needed.

### Memory Management

- **`[weak self]`** in all stored closures, notification observers, and `Task` closures that may outlive `self`:
  ```swift
  Task { @MainActor [weak self] in
      guard let self else { return }
      await self.doWork()
  }
  ```
- **Do not use `[unowned self]`** — this codebase consistently uses `[weak self]` with `guard let self`.
- **Cancel stored `Task` handles** in `deinit` or cleanup methods. Remove `NotificationCenter` observers on teardown.
- **Prefer structs** for data models — no retain cycles, value semantics, natural `Codable` conformance.
- Store **`AnyCancellable`** for any Combine subscriptions.

### Value Types vs Reference Types

- **Structs** for: data models (`KnowledgeEntry`, `AgentAction`, `AXElement`), IPC messages (`CuObservationMessage`), configurations, DTOs.
- **Classes** for: `ObservableObject` state holders (`ComputerUseSession`, `DaemonClient`, `AmbientAgent`), stateful services (`ActionExecutor`), `NSObject` subclasses (`AppDelegate`, NSWindow subclasses).
- **Enums** with associated values for: state machines (`SessionState`, `AmbientAgentState`), error types, action types, verification results.

### Testing

- **Protocol-based DI** with `Mock*` implementations in the test target (defined in `SessionTests.swift`).
- Test signature: **`@MainActor func testX() async`** for testing `@MainActor`-isolated code.
- Test naming: **`test<Behavior>_<scenario>_<expected>`** — e.g. `testLoopDetection_threeIdenticalActions_blocked`.
- Mocks: **record calls** (spy) and **accept injected return values** (stub). Use typed arrays (`var executedActions: [AgentAction]`), not `[Any]`.
- Prefer **`XCTAssertEqual(a, b)`** over `XCTAssertTrue(a == b)` for better failure messages.
- Use `// MARK: -` to group related tests within a file.
- One test file per production file or feature area.
- Use **private factory helpers** (`makeSession(...)`, `makeActionMessage(...)`) for test setup to reduce boilerplate.

### SwiftUI + AppKit Interop

- **SwiftUI** for all user-facing views (overlays, settings, onboarding, input).
- **AppKit** only where SwiftUI cannot reach: `NSStatusItem`, `NSPopover`, `NSPanel` for floating overlays, `CGEvent` injection, `AXUIElement` APIs, `NSWorkspace`.
- Embed SwiftUI in AppKit via **`NSHostingController`** (for popovers) and **`NSHostingView`** (for windows).
- For floating overlays: use **`NSPanel`** with `.floating` level and `.canJoinAllSpaces` collection behavior.
- For LSUIElement activation policy: toggle to **`.regular`** when showing standalone windows, revert to **`.accessory`** when they close.

### Code Organization

- Group files by **feature domain**: `ComputerUse/`, `Ambient/`, `IPC/`, `UI/`, `App/`, `Inference/`, `Logging/`.
- **One primary type per file**, named after the type.
- Use **`// MARK: - Section`** for: Properties, Initialization, Public API, Private Helpers. (With dash for major sections.)
- Put **protocol conformances in separate extensions** with MARK comments when non-trivial.
- **Imports** ordered: Foundation, Apple frameworks (`AppKit`, `CoreGraphics`), third-party (`HotKey`). Alphabetize within groups. Keep imports minimal per file.
- **Split files >300 lines** into extensions: `Type.swift`, `Type+Feature.swift`. SPM merges automatically.
- **Computed properties** for O(1) side-effect-free values (`isEmpty`, `recentEntries`). **Methods** for everything else.

### Logging

- Use **`os.Logger`** exclusively. Never `print()` in production code.
- Hardcoded subsystem fallback: `Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "YourCategory")`.
- Log levels: `.debug` (verbose tracing), `.info` (normal operation), `.warning` (recoverable issues), `.error` (failures).
- Use **`privacy: .public`** only for non-sensitive data. Default string interpolation is private (redacted in release logs).

### macOS-Specific

- Check **permissions at runtime**, not just at launch. Users can revoke while the app runs.
- Handle **AX tree unavailability gracefully** — elements may be stale, missing, or change across `await` points.
- Include **delays between CGEvent mouseDown/mouseUp** (50-100ms) to prevent event coalescing.
- **Save/restore clipboard** when using paste-based text input.
- For Chrome/Electron: detect missing AX web content and handle via `ChromeAccessibilityHelper`.

### Performance

- Use **`contains(where:)`** / **`first(where:)`** instead of `filter { }.isEmpty` or `filter { }.first`.
- Use **`lazy`** sequences for chained transformations that don't need materialization.
- Use **`lazy var`** for expensive initializations that may not be needed.
- Use **`reserveCapacity(_:)`** when collection size is known in advance.
- Profile with **Instruments in Release mode** before optimizing.

### Anti-Patterns to Avoid

- **No force unwraps (`!`)** on external data (network, user input, AX queries). Only acceptable for known-constant URLs, system directories, or after a success guard.
- **No stringly-typed code** — use enums and static constants for identifiers, keys, notification names.
- **No `[String: Any]`** for structured data — use `Codable` structs. (`AnyCodable` is acceptable only at the JSON serialization boundary.)
- **No singletons** without protocol abstraction for testability.
- **No premature abstraction** — don't create protocols with a single conformer unless needed for DI/testing.
- **No new SPM dependencies** without explicit approval.
- **No Combine pipelines** for async work — use async/await.
- **No `DispatchQueue`** for new code — use structured concurrency.

### Reference Files

Read these to understand established patterns before making changes:

| Pattern | File |
|---------|------|
| Session loop, @MainActor, protocol DI | `ComputerUse/Session.swift` |
| AsyncStream, reconnect, Unix socket IPC | `IPC/DaemonClient.swift` |
| CGEvent injection, clipboard management | `ComputerUse/ActionExecutor.swift` |
| Typed error enums, retry logic | `Inference/AnthropicClient.swift` |
| Background Task management, ObservableObject | `Ambient/AmbientAgent.swift` |
| AXUIElement tree traversal | `ComputerUse/AccessibilityTree.swift` |
| IPC protocol, AnyCodable, Codable structs | `IPC/IPCMessages.swift` |
| Mock patterns, async test structure | `Tests/SessionTests.swift` |
| State enum pattern matching in SwiftUI | `UI/SessionOverlayView.swift` |
| Safety checks, enum-based results | `ComputerUse/ActionVerifier.swift` |
