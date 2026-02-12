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
9. The main window shows a chat interface — type a message to start a conversation
10. Responses stream in real-time from the daemon
11. Click the stop button to cancel an in-progress generation

**Current limitations:** Single active generation at a time, text-only messages, no conversation history browser.

## Xcode Previews

The package is split into a library target (`VellumAssistantLib`) and a thin executable target (`vellum-assistant`). This lets you preview SwiftUI views live in Xcode without building and running the whole app.

### Prerequisites

1. **Install Xcode** — Download from the [Mac App Store](https://apps.apple.com/us/app/xcode/id497799835) (free, requires macOS). It's a large download (~7 GB), so this may take a while.
2. **Open Xcode once** after installing and accept the license agreement. It will install additional components automatically.

### Step-by-step: Opening the project

1. Open Terminal and run:
   ```bash
   open clients/macos/Package.swift
   ```
   This opens the Swift package in Xcode. You can also double-click `Package.swift` in Finder.

2. Xcode will open and start resolving dependencies (you'll see a spinner in the top status bar). Wait for it to finish — this only takes a few seconds.

### Step-by-step: Viewing a preview

1. **Select the library scheme.** At the very top center of the Xcode window, there's a dropdown button that shows the current scheme (it probably says `vellum-assistant > My Mac`). Click it and switch to **`VellumAssistantLib`**. Previews only work on the library target — the executable target will show an error about `ENABLE_DEBUG_DYLIB`.

2. **Open a SwiftUI file.** In the left sidebar (file navigator), expand `vellum-assistant` and navigate to any SwiftUI view, for example:
   - `Features/Settings/SettingsView.swift`
   - `Features/Onboarding/OnboardingFlowView.swift`
   - `UI/SessionOverlayView.swift`

3. **Show the Canvas.** Go to the menu bar: **Editor → Canvas** (or press `⌥⌘↩` / Option+Command+Return). A preview panel appears on the right side of the editor.

4. **Resume the preview.** If the canvas says "Preview paused", click the **Resume** button at the top of the canvas (or press `⌥⌘P` / Option+Command+P). Xcode will build the library and render the preview.

### Important: Views need a `#Preview` block

A SwiftUI file will **only show a preview** if it contains a `#Preview` block. If you open a file and the canvas is blank or says "No preview available", the file is missing one.

To add a preview, put this at the bottom of the file (outside any struct):

```swift
#Preview {
    MyViewName()
}
```

For example, `SettingsView` requires an argument:

```swift
#Preview {
    SettingsView(ambientAgent: AmbientAgent())
}
```

### Troubleshooting

| Problem | Fix |
|---------|-----|
| "ENABLE_DEBUG_DYLIB" error | Switch the scheme to **`VellumAssistantLib`** (not `vellum-assistant`) |
| Canvas is blank / "No preview available" | The file needs a `#Preview { ... }` block — see above |
| "Preview paused" | Click **Resume** in the canvas or press `⌥⌘P` |
| Build errors in the canvas | Try **Product → Clean Build Folder** (`⇧⌘K`) then resume |

## Architecture

```
App/                  AppDelegate, menu bar setup, permissions, voice input
vellum-assistant-app/ Entry point (@main VellumAssistantApp — thin wrapper)
ComputerUse/          Core perception + action pipeline
  AccessibilityTree   AX element enumeration & formatting
  AXTreeDiff          Diff between AX tree snapshots across steps
  ActionExecutor      CGEvent mouse/keyboard injection
  ActionVerifier      Safety checks (sensitive data, loops, limits)
  ChromeAccessibilityHelper  Auto-restart Chrome with --force-renderer-accessibility
  ScreenCapture       ScreenCaptureKit screenshot capture
  Session             Main orchestration loop
Inference/            AI action selection
  AnthropicClient     Shared HTTP client with retry logic (used by KnowledgeCron)
  ToolDefinitions     Tool schemas for function calling
IPC/                  Daemon communication
  DaemonClient        Unix domain socket IPC client (auto-reconnect, ping/pong)
  IPCMessages         Codable structs mirroring ipc-protocol.ts
Ambient/              Background screen-watching agent
  AmbientAgent        Periodic capture → OCR → analyze via daemon IPC
  AmbientAnalyzer     Type definitions (AmbientDecision, AmbientAnalysisResult)
  KnowledgeStore      Persists observations as JSON
  KnowledgeCron       Triggers periodic insight analysis
  InsightStore        Higher-level insights derived from observations
  ScreenOCR           Vision framework OCR
Features/Chat/        Main window chat interface
  ChatMessage         Message model (role, text, streaming state)
  ChatView            Presentational view (bubbles, composer, thinking, error banner)
  ChatViewModel       Session bootstrap, streaming, cancel via daemon IPC
UI/                   SwiftUI views + overlay windows
  Onboarding/         First-launch setup flow (permissions, naming, Fn key)
Logging/              Session recording to JSON
```

## Remote Daemon

The app supports connecting to a remote daemon via SSH socket forwarding. Set `VELLUM_DAEMON_SOCKET` to the forwarded socket path. See the [Remote Access](../../README.md#remote-access) section in the root README.

## Safety

- Credit cards, SSNs, and passwords are blocked at the verifier level
- Destructive key combos (Cmd+Q, Cmd+W, Cmd+Delete) require explicit user confirmation
- Form submission (Enter after typing) requires confirmation
- Loop detection aborts stuck agents (3 identical consecutive actions)
- Step limit enforced (default 50, configurable)
- System menu bar (top 25px) is off-limits
- Escape key or Stop button instantly cancels
