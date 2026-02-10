# vellum-assistant

A native macOS menu bar app that controls your Mac via accessibility APIs and CGEvent input injection, powered by Claude via the Anthropic Messages API with tool use.

## Requirements

- macOS 14.0 (Sonoma) or later
- Xcode 15+ (for building)
- Anthropic API key

## Build

```bash
# Resolve dependencies
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift package resolve

# Build
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift build

# Run tests
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test

# Build for release
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift build -c release
```

## Stable Dev Run (Persist Permissions)

`swift run` rebuilds and runs an unsigned binary, which can trigger macOS Privacy & Security prompts repeatedly.
Use the signed app launcher instead:

```bash
# One-time: set your Apple team ID (or set this in Local.xcconfig)
export DEVELOPMENT_TEAM=YOUR_TEAM_ID

# Build + launch from a stable .app path
scripts/run-dev.sh
```

What this does:
- Builds `vellum-assistant.app` with `xcodebuild` and automatic signing
- Uses a fixed DerivedData location: `.dev/DerivedData`
- Launches the same app bundle path each run, so TCC permissions stick across rebuilds

Useful options:

```bash
# Build without launching
scripts/run-dev.sh --build-only

# Clean build
scripts/run-dev.sh --clean

# Override team ID
scripts/run-dev.sh --team YOUR_TEAM_ID
```

## Permissions

The app requires three macOS permissions:
- **Accessibility** — For reading UI element trees and injecting mouse/keyboard events
- **Screen Recording** — For capturing screenshots (vision fallback when AX tree is sparse)
- **Microphone** — For voice input via speech recognition

Grant these in System Settings → Privacy & Security.

## Usage

1. Launch the app — an onboarding flow guides you through permissions and setup on first run
2. The app appears as a sparkles icon in your menu bar
3. Open Settings (click icon → gear) and enter your Anthropic API key
4. Click the menu bar icon or press `⌘⇧G` to open the task input
5. Type a task (e.g., "Fill in the name field with John Smith") and press Go
6. Or hold the Fn key to dictate a task via voice
7. Watch the overlay as vellum-assistant works through the task
8. Press Escape at any time to cancel

## Architecture

```
App/                  Entry point, AppDelegate, menu bar setup, permissions, voice input
ComputerUse/          Core perception + action pipeline
  AccessibilityTree   AX element enumeration & formatting
  AXTreeDiff          Diff between AX tree snapshots across steps
  ActionExecutor      CGEvent mouse/keyboard injection
  ActionVerifier      Safety checks (sensitive data, loops, limits)
  ChromeAccessibilityHelper  Auto-restart Chrome with --force-renderer-accessibility
  ScreenCapture       ScreenCaptureKit screenshot capture
  Session             Main orchestration loop
Inference/            AI action selection
  AnthropicClient     Shared HTTP client with retry logic
  AnthropicProvider   Claude API integration (session inference)
  ToolDefinitions     Tool schemas for function calling
Ambient/              Background screen-watching agent
  AmbientAgent        Periodic capture → OCR → analyze orchestration
  AmbientAnalyzer     Sends OCR text to Haiku for ignore/observe/suggest decisions
  KnowledgeStore      Persists observations as JSON
  KnowledgeCron       Triggers periodic insight analysis
  InsightStore        Higher-level insights derived from observations
  ScreenOCR           Vision framework OCR
UI/                   SwiftUI views + overlay windows
  Onboarding/         First-launch setup flow (permissions, naming, Fn key)
Logging/              Session recording to JSON
```

## Safety

- Credit cards, SSNs, and passwords are blocked at the verifier level
- Destructive key combos (Cmd+Q, Cmd+W, Cmd+Delete) require explicit user confirmation
- Form submission (Enter after typing) requires confirmation
- Loop detection aborts stuck agents (3 identical consecutive actions)
- Step limit enforced (default 50, configurable)
- System menu bar (top 25px) is off-limits
- Escape key or Stop button instantly cancels
