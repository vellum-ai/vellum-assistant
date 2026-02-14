# vellum-assistant

A native macOS menu bar app that controls your Mac via accessibility APIs and CGEvent input injection, powered by Claude via the Anthropic Messages API with tool use.

## iOS Target

This repository also includes an iOS app target (`vellum-assistant-ios`) that shares ~45-50% of code with the macOS app through the `VellumAssistantShared` library. The iOS app is a chat-focused client that connects to a network-accessible daemon via TCP.

**Status:** Basic structure in place (PR 4 of 13). The iOS target requires xcodebuild with iOS SDK to build - it cannot be built with `swift build` on macOS due to UIKit dependencies.

**Code organization:**
- `clients/shared/` — Shared library (IPC layer, chat models/ViewModels, design system)
- `clients/macos/` — macOS-specific code (accessibility, CGEvent, computer-use)
- `clients/ios/` — iOS-specific code (UIKit app structure, SwiftUI views)

### Testing the iOS App

The iOS app can be tested in three ways:

**1. Xcode Simulator (Recommended for development)**
```bash
# Open the iOS target in Xcode
open clients/Package.swift

# In Xcode:
# - Select the vellum-assistant-ios scheme
# - Choose an iOS Simulator (iPhone 15, iPad Pro, etc.)
# - Click Run (⌘R)
```

**Pros:** No signing needed, fast iteration, free
**Cons:** No push notifications, camera, or some hardware features
**Use for:** Chat interface, settings, basic UI testing

**2. Physical Device (For hardware features)**

Requires either:
- Free personal Apple ID (7-day code signing)
- Paid Apple Developer account ($99/year, 1-year signing)

```bash
# In Xcode:
# - Connect your iPhone/iPad via USB
# - Select your device in the destination menu
# - Xcode will prompt for Apple ID and handle signing
# - Click Run (⌘R)
```

**Use for:** Voice input, camera/photo picker, push notifications

**3. TestFlight (For beta testing)**

Requires Apple Developer account + App Store Connect setup. Deferred to PR 12-13 (deployment).

**Daemon Connection Note:** The iOS app connects to the daemon via TCP (default: localhost:8765). For Simulator testing, the daemon should run on your Mac. For device testing, configure the daemon hostname to your Mac's IP address in Settings.

## Requirements

- macOS 14.0 (Sonoma) or later
- Xcode 15+ (for building)
- Anthropic API key

## Quick Run

The fastest way to build and launch the app locally:

```bash
./build.sh run
```

This builds a debug `.app` bundle, codesigns it, and launches it immediately.

## Build

```bash
# Build debug .app bundle (→ dist/Vellum.app)
./build.sh

# Build + launch
./build.sh run

# Build release
./build.sh release

# Run all tests
./build.sh test

# Clean build artifacts
./build.sh clean
```

The build script uses incremental compilation and caching:

- Running `./build.sh` again without code changes takes ~1-2s (skips binary copying, still updates Info.plist/assets/codesigning)
- Small code changes rebuild in ~4 seconds
- Use `./build.sh clean` if you encounter build issues, need to force a complete rebuild, or after removing resources/frameworks (incremental builds don't detect deletions)

## Auto-Rebuild on Save (Watch Mode)

For faster development iteration, use the watch script to automatically rebuild and relaunch when you save Swift files or resources:

```bash
./watch.sh
```

**Workflow:**
1. Start `./watch.sh` in a terminal
2. Edit Swift files or resources (images, fonts, JSON, assets) in your editor
3. Save (Cmd+S)
4. App automatically rebuilds and relaunches in ~4 seconds!
5. Multiple rapid saves are debounced automatically

## SwiftPM Commands

The raw SwiftPM commands also work if you prefer:

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

## Test DMG Installer

To preview the DMG installer layout locally (requires `brew install create-dmg`):

```bash
./dmg/test-dmg.sh
```

This builds the app (if needed), generates the background image, creates a styled DMG, and opens it in Finder.

## Daemon

The macOS app is a frontend — all inference (chat, computer-use sessions, ambient analysis) goes through the **daemon**, a Node/Bun process that manages Claude API calls, conversation state, and tool execution. The app connects to the daemon via a Unix domain socket at `~/.vellum/vellum.sock`.

**You must start the daemon before using the app.** Without it, the app will connect but get no responses.

```bash
# Start the daemon (from the repo root)
cd assistant && bun run dev

# Or use the CLI
cd assistant && bun run src/index.ts daemon start
```

The app will auto-reconnect if the daemon restarts. For development, `bun run dev` runs in the foreground with auto-restart on file changes.

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

### Opportunistic Message Queueing

Users can send multiple messages while the assistant is busy. Messages are queued (FIFO, max 10) and processed automatically:

- The queue drains at safe tool-loop checkpoints, not just at full completion
- UI shows queue status: "N messages queued, sending automatically"
- Message bubbles show status: queued (dimmed) -> processing -> sent
- The daemon emits `generation_handoff` when it yields to queued work at a checkpoint, followed by `message_dequeued` as each queued message begins processing

**Current limitations:** Text-only messages, no conversation history browser.

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
                      Includes: message_queued, message_dequeued,
                      generation_handoff (sessionId, requestId?, queuedCount)
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
