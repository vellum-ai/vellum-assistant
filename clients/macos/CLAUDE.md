# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A native macOS menu bar app that controls your Mac via accessibility APIs and CGEvent input injection, powered by Claude via the Anthropic Messages API with tool use. It lives as a sparkles icon in the menu bar — users type a task (or will soon use voice), and the agent executes it step-by-step.

## Build & Test

The project has **dual build systems**: an Xcode project (generated via XcodeGen from `project.yml`) and a SwiftPM `Package.swift`. The Xcode build is the primary one for the app bundle:

```bash
# Build (release, via xcodebuild)
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -scheme vellum-assistant -configuration Release -derivedDataPath build build

# Build (debug, via SPM — faster iteration, but no bundle ID at runtime)
swift build

# Run tests
swift test

# Watch logs from a running instance
log stream --predicate 'subsystem == "com.vellum.vellum-assistant"' --level debug
```

## Architecture

**Session loop** (`Session.swift`) — the core orchestration cycle runs per-task:
1. **PERCEIVE** — enumerate the AX tree of the focused window (`AccessibilityTree.swift`); fall back to screenshot (`ScreenCapture.swift`) if no tree available
2. **INFER** — send AX tree (or screenshot) + task + action history to Claude via Anthropic Messages API with forced tool use (`AnthropicProvider.swift`); model returns exactly one tool call per turn
3. **VERIFY** — safety checks: sensitive data, destructive keys, loop detection, step limits, system menu bar exclusion (`ActionVerifier.swift`)
4. **EXECUTE** — inject mouse/keyboard events via CGEvent (`ActionExecutor.swift`)
5. **LOG** — record each turn to JSON (`SessionLogger.swift`)

**App lifecycle** (`AppDelegate.swift`) — sets up NSStatusItem with NSPopover for task input, global hotkey (Cmd+Shift+G via HotKey package), and global Escape monitor. `VellumAssistantApp.swift` is the `@main` entry point using `@NSApplicationDelegateAdaptor`.

**Inference** — `ActionInferenceProvider` protocol with `AnthropicProvider` implementation. Uses 8 tools: `click`, `double_click`, `right_click`, `type_text`, `key`, `scroll`, `wait`, `done`. Element targeting uses `[ID]` numbers from the AX tree resolved to screen coordinates via `resolvePosition`.

**Text input** uses clipboard-paste (Cmd+V) rather than keystroke simulation, with clipboard save/restore.

## Key Constraints

- **LSUIElement app** — no dock icon; uses `.accessory` activation policy. Must temporarily switch to `.regular` when showing Settings window (see `TaskInputView.swift`).
- **`Bundle.main.bundleIdentifier` is nil** when built via SwiftPM (no app bundle). The `os.Logger` subsystem uses a hardcoded fallback `"com.vellum.vellum-assistant"`.
- **Two plists**: `Info.plist` (for SPM) and `Info-generated.plist` (for Xcode/XcodeGen). When adding new plist keys (e.g., usage descriptions), update both.
- **Adding new .swift files**: When adding source files, they are automatically picked up by SwiftPM but must be **manually added to `vellum-assistant.xcodeproj/project.pbxproj`** (add to both PBXFileReference and PBXSourcesBuildPhase). Look at how `ChromeAccessibilityHelper.swift` was added as a pattern.
- **Chrome special handling** — `ChromeAccessibilityHelper` detects when Chrome's AX tree lacks web content and auto-restarts Chrome with `--force-renderer-accessibility`.
- **Popover close delay** — 300ms delay before session starts to let the popover close and target app regain focus.

## Permissions

The app requires macOS Accessibility and Screen Recording permissions (System Settings > Privacy & Security). `PermissionManager` and `ActionExecutor.checkAccessibilityPermission` handle checking/prompting.

## Session Logs

Written to `~/Library/Application Support/vellum-assistant/logs/session-*.json`.
