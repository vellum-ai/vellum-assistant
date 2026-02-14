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

### Feature Modules (`Features/`)

All UI and feature code lives in `Features/`, organized by domain:

| Module | Purpose |
|--------|---------|
| `Chat/` | ChatView, ChatViewModel (multi-turn messaging), ChatMessage model |
| `MainWindow/` | MainWindowView shell, ThreadTabBar, NavigationToolbar, ThreadManager, 6 side panels |
| `Onboarding/` | Multi-step first-launch flow (OnboardingFlowView → OnboardingState) |
| `Session/` | Session overlay UI for computer-use task execution |
| `Settings/` | API key entry, hotkey config, permission status |
| `Ambient/` | Background screen monitoring UI |
| `Voice/` | Voice input UI (VoiceTranscriptionWindow) |
| `MenuBar/` | NSStatusItem and popover lifecycle |
| `Surfaces/` | Daemon surface rendering (HTML/JSON overlays) |
| `TaskInput/` | Quick task input popover |

**Main window layout** (`MainWindowView`):
```
ThreadTabBar          (row 1 — thread tabs, extends into titlebar)
NavigationToolbar     (row 2 — Chat tab + panel toggle buttons)
VSplitView            (row 3 — ChatView + optional side panel)
```

**Data flow**: `ThreadManager` (`@MainActor ObservableObject`) owns `[ThreadModel]` and a dictionary of `ChatViewModel` instances keyed by thread ID. `MainWindowView` binds to the active `ChatViewModel` via `threadManager.activeViewModel`. ThreadManager subscribes to each nested ChatViewModel's `objectWillChange` and forwards it via Combine so SwiftUI picks up changes.

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

The package is split into two targets for Xcode Preview support:
- **`VellumAssistantLib`** (library) — all app code, resources, and linker settings. Previews work on any SwiftUI view here.
- **`vellum-assistant`** (executable) — thin `@main` entry point in `vellum-assistant-app/` that imports `VellumAssistantLib`.

`AppDelegate` sets up: NSStatusItem with NSPopover, global hotkey (Cmd+Shift+G via HotKey package), global Escape monitor, voice input, ambient agent, and onboarding flow. `VellumAssistantApp` is the `@main` entry point with `@NSApplicationDelegateAdaptor`.

### Onboarding

`Features/Onboarding/` — multi-step flow (`OnboardingFlowView` → `OnboardingState`) covering wake-up animation, naming, permissions (screen recording, microphone), Fn key setup, and an alive-check step. Shown on first launch; skip with `--skip-onboarding` in debug.

## Design System (`DesignSystem/`)

The design system uses a two-tier architecture with functional subgrouping:

```
DesignSystem/
├── Tokens/              (VColor, VFont, VSpacing, VRadius, VShadow, VAnimation)
├── Core/                (atomic building blocks — single-responsibility controls)
│   ├── Buttons/         (VButton, VIconButton, VCircleButton)
│   ├── Inputs/          (VSlider, VTextEditor, VTextField, VToggle)
│   ├── Feedback/        (VBadge, VLoadingIndicator, VToast)
│   ├── Display/         (VListRow)
│   └── Navigation/      (VTab)
├── Components/          (composed patterns — combine multiple Core elements)
│   ├── Navigation/      (VTabBar, VSegmentedControl)
│   ├── Layout/          (VSidePanel, VSplitView, VToolbar)
│   └── Display/         (VCard, VEmptyState)
├── Modifiers/           (.vCard(), .vHover(), .vPanelBackground())
└── Gallery/             (ComponentGalleryView — visual catalog of all tokens/components)
```

**Classification rule:**
- **Core** = atomic, single-responsibility control (wraps one native SwiftUI element or thin styling layer). Place in `Core/`.
- **Component** = composes multiple Core elements or has internal layout logic (VTabBar arranges VTabs, VCard has header/body slots, VEmptyState composes icon + title + subtitle). Place in `Components/`.
- **Feature-specific** views (e.g. ThreadTab) belong in `Features/`, not in the design system.

All design system types use the `V` prefix (VButton, VColor, VFont, etc.). Always use design tokens instead of raw values — `VFont.body` not `Font.system(size: 13)`, `VColor.accent` not `Color.purple`.

### Token Reference

**VColor** — Semantic color tokens mapped to Tailwind-style scales (Slate, Violet, Emerald, Rose, Amber, Indigo):
- Backgrounds: `background` (Slate._950), `backgroundSubtle` (Slate._800), `surface` (Slate._800), `surfaceBorder` (Slate._700)
- Text: `textPrimary` (Slate._50), `textSecondary` (Slate._400), `textMuted` (Slate._500)
- Accent: `accent` (Violet._600), `accentSubtle` (Violet._100)
- Status: `success` (Emerald._600), `error` (Rose._600), `warning` (Amber._600)
- Use raw scales (e.g. `Slate._300`, `Violet._700`) only when semantic tokens don't cover the need.

**VFont** — macOS HIG-aligned type scale:
- `largeTitle` (26pt bold), `title` (22pt semibold), `headline` (13pt bold)
- `body` (13pt), `bodyMedium` (13pt medium), `bodyBold` (13pt semibold)
- `caption` (11pt), `captionMedium` (11pt medium), `small` (10pt)
- `mono` (13pt monospaced), `monoSmall` (11pt monospaced)
- `display` (18pt black monospaced — for panel headers like "AGENT", "GENERATED CONTENT")
- `cardTitle` (17pt semibold), `cardEmoji` (32pt)

**VSpacing** — 4pt grid: `xxs`(2), `xs`(4), `sm`(8), `md`(12), `lg`(16), `xl`(24), `xxl`(32), `xxxl`(48). Semantic aliases: `inline`=sm, `content`=lg, `section`=xl, `page`=xxl.

**VRadius** — `xs`(2), `sm`(4), `md`(8), `lg`(12), `xl`(16), `pill`(999).

**VAnimation** — `fast` (0.15s easeOut), `standard` (0.25s easeInOut), `slow` (0.4s easeInOut), `spring`, `panel` (gentle spring for panels), `bouncy` (celebratory spring).

**VShadow** — `sm`, `md`, `lg`, `glow` (Amber), `accentGlow` (Violet). Applied via `.vShadow()` modifier.

## SwiftUI & Swift Conventions

### State Management

| Pattern | When to use |
|---------|-------------|
| `@State` | Local, view-scoped transient state (hover, drag, focus, form fields) |
| `@Binding` | Pass mutable state from parent to child view |
| `@StateObject` | Own an ObservableObject for the view's lifetime (e.g. ThreadManager in MainWindowView) |
| `@ObservedObject` | Observe an ObservableObject owned elsewhere |
| `@AppStorage` | Persistent user preferences backed by UserDefaults |
| `@Observable` | Modern Observation framework (used by OnboardingState) |

### Rules

- **`@MainActor` on all ObservableObject classes** — all view models and managers that touch UI must be `@MainActor`.
- **Nested ObservableObject**: When a view reads properties from a nested ObservableObject (e.g. `threadManager.activeViewModel.messages`), the parent must subscribe to the child's `objectWillChange` and forward it. See `ThreadManager.subscribeToActiveViewModel()`.
- **Dependency injection**: Pass dependencies (DaemonClient, AmbientAgent) through init parameters, not singletons. Session dependencies use protocols for testability.
- **Previews**: Add `#Preview("ComponentName")` blocks to every new view. Wrap in `ZStack { VColor.background.ignoresSafeArea() ... }` to match the dark theme. Use `#if DEBUG` guards for preview-only code. Keep preview frames reasonable (400-600pt wide). **Never use `@Previewable`** — it's not supported on CI's Xcode 16.2. If a preview needs `@State`, use a `PreviewProvider` with a wrapper view instead (see `ThreadTabBar.swift` for the pattern).
- **Gallery**: When adding or modifying a design system primitive/component, update the corresponding Gallery section file (`Gallery/Sections/`) so the visual catalog stays current.
- **Accessibility**: Add `.accessibilityLabel()` to icon-only buttons, `.accessibilityHidden(true)` to decorative elements, and `.accessibilityValue()` to stateful controls. See existing components for patterns.

### Naming & File Placement

- Design system types: `V` prefix (VButton, VColor, VTab, etc.)
- Feature views: Place in `Features/<Module>/`. New feature modules get their own directory.
- New `.swift` files are auto-picked up by SPM — no project file edits needed.
- Panel views: Place in `Features/MainWindow/Panels/` and add a case to `SidePanelType`.

## Key Constraints

- **LSUIElement app** — no dock icon; uses `.accessory` activation policy. Must temporarily switch to `.regular` when showing Settings window.
- **`Bundle.main.bundleIdentifier` is nil** in SPM builds. All `os.Logger` instances use hardcoded fallback `"com.vellum.vellum-assistant"`.
- **Adding .swift files**: Auto-picked up by SPM. No manual project file edits needed. New files go in `vellum-assistant/` (library target); only `@main` entry point lives in `vellum-assistant-app/`.
- **Chrome special handling** — `ChromeAccessibilityHelper` detects when Chrome's AX tree lacks web content and auto-restarts Chrome with `--force-renderer-accessibility`.
- **Popover close delay** — 300ms initial delay before session starts to let the popover close and target app regain focus.
- **SessionState enum** must stay in sync with `SessionOverlayView` pattern matching.
- **SourceKit false positives** — SourceKit may report "Cannot find X in scope" for design system types (VColor, VFont, etc.) due to SPM module resolution. These are false positives — `swift build` succeeds. Do not "fix" these by adding imports or changing code.

## Permissions

Requires Accessibility, Screen Recording, and Microphone permissions (System Settings > Privacy & Security). `PermissionManager` handles checking/prompting. API key stored in Keychain via `APIKeyManager`.

## Data Storage

- Session logs: `~/Library/Application Support/vellum-assistant/logs/session-*.json`
- Knowledge store: `~/Library/Application Support/vellum-assistant/knowledge.json`
