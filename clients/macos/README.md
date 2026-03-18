# vellum-assistant

A native macOS menu bar app that controls your Mac via accessibility APIs and CGEvent input injection, powered by large language models with tool use.

---

## Table of Contents

1. [iOS Target](#ios-target)
2. [Managed Mode](#managed-mode)
3. [Download](#download)
4. [Requirements](#requirements)
5. [Quick Run](#quick-run)
6. [Build](#build)
7. [Auto-Rebuild on Save](#auto-rebuild-on-save-watch-mode)
8. [SwiftPM Commands](#swiftpm-commands)
9. [Test DMG Installer](#test-dmg-installer)
10. [Local Assistant (Daemon)](#local-assistant-daemon)
11. [Permissions](#permissions)
12. [Usage](#usage)
13. [Component Gallery](#component-gallery-debug)
14. [Architecture](#architecture)
15. [Remote Assistant](#remote-assistant)
16. [Safety](#safety)

---

## iOS Target

This repository also includes a fully functional iOS app target. See [clients/ios/README.md](../ios/README.md) for build instructions, connection modes, testing, and configuration.

---

## Managed Mode

The app supports a **managed sign-in** flow that connects to a platform-hosted assistant instead of a local daemon.

### Sign-in Flow

1. User clicks "Sign in" during first-run onboarding
2. WorkOS authentication opens in the system browser
3. On success, `ManagedAssistantBootstrapService.ensureManagedAssistant()` discovers or creates a platform assistant
4. A lockfile entry is written with `cloud: "vellum"` and the `connectedAssistantId` is persisted in UserDefaults
5. HTTP transport is configured in `platformAssistantProxy` mode with session token auth

### Transport Modes

The `HTTPTransport` supports two route modes:

- **`runtimeFlat`** -- Used for local daemon connections and custom remote setups. Paths follow the runtime layout (e.g., `/v1/messages`, `/v1/events`).
- **`platformAssistantProxy`** -- Used in managed mode. Paths are scoped under `/v1/assistants/{id}/` with trailing slashes (Django convention), e.g., `/v1/assistants/{id}/messages/`.

### Key Differences in Managed Mode

- No local daemon process -- the assistant runs on the Vellum platform
- No actor credentials or bearer token -- session token auth is used instead (stored in Keychain)
- Onboarding skips local daemon hatching and Fn key setup
- If bootstrap fails, the user stays on the onboarding screen with a retry option

### Where State Lives

| State | Location |
|-------|----------|
| Session token | Keychain (`AuthManager`) |
| Lockfile entry | `~/.vellum.lock.json` (with `cloud: "vellum"`) |
| Connected assistant ID | UserDefaults (`connectedAssistantId`) |

For the full managed sign-in architecture, see `clients/ARCHITECTURE.md`.

---

## Download

To install the pre-built macOS app, download the signed and notarized DMG:

**[Download Vellum.dmg](https://github.com/vellum-ai/velly/releases/latest/download/vellum-assistant.dmg)**

1. Open the DMG and drag **Vellum.app** to your Applications folder
2. Launch Vellum — macOS may prompt "are you sure?" on first launch (click Open)
3. The app appears as a sparkles icon in your menu bar

The app includes **Sparkle auto-update** — after the initial install, updates are downloaded and applied automatically in the background. You'll be prompted to relaunch when a new version is ready.

> **Note (local mode):** You need the daemon running for the app to function in local mode. See the [Local Assistant (Daemon)](#local-assistant-daemon) section below for setup. In managed mode, the assistant runs on the Vellum platform and no local daemon is required.

All releases are available at [github.com/vellum-ai/velly/releases](https://github.com/vellum-ai/velly/releases).

---

## Requirements

### Local Mode
- macOS 14.0 (Sonoma) or later
- Xcode 15+ (for building from source)
- Anthropic API key
- Local daemon running (`vellum wake`)

### Managed Mode
- macOS 14.0 (Sonoma) or later
- Xcode 15+ (for building from source)
- Internet connection (assistant runs on the Vellum platform)
- No API key or local daemon required

---

## Quick Run

The fastest way to build and launch the app locally:

```bash
./build.sh run
```

To point managed sign-in at a specific platform host for a local run:

```bash
VELLUM_PLATFORM_URL=https://platform.vellum.ai ./build.sh run
```

This builds a debug `.app` bundle, codesigns it, and launches it immediately.

---

## Build

```bash
# Build debug .app bundle (→ dist/Vellum.app)
./build.sh

# Build + launch + watch for changes (auto-rebuild)
./build.sh run

# Build release
./build.sh release

# Run macOS-specific tests
./build.sh test

# Clean build artifacts
./build.sh clean
```

The build script uses incremental compilation and caching:

- Running `./build.sh` again without code changes takes ~1-2s (skips binary copying, still updates Info.plist/assets/codesigning)
- Small code changes rebuild in ~4 seconds
- Use `./build.sh clean` if you encounter build issues, need to force a complete rebuild, or after removing resources/frameworks (incremental builds don't detect deletions)

### First-Time Setup: Code Signing (Optional but Recommended)

Code signing helps macOS TCC (permission system) recognize your app consistently across rebuilds. **Without it, you'll need to re-grant Accessibility and Screen Recording permissions every time you rebuild.**

The build script automatically detects and uses any valid code signing certificate in your keychain. If none is found, it falls back to adhoc signing (unsigned).

**Recommended: Create an Apple Development certificate via Xcode** (takes ~2 minutes, works with free Apple ID):

1. Open any Swift file in Xcode:
   ```bash
   # From clients/macos/ directory:
   open vellum-assistant/App/AppDelegate.swift
   ```

2. In Xcode menu bar: **Xcode → Settings → Accounts**

3. Click **+** to add your Apple ID (free account works - no $99/year Developer Program needed)

4. Select your Apple ID → click **Manage Certificates** → click **+** → select **Apple Development**

5. Xcode creates and installs the certificate in your keychain automatically

6. Close Xcode and rebuild: `./build.sh`

The build script will detect and use your new certificate. Permissions will now persist across rebuilds!

**Alternative: Use adhoc signing** (no setup, but permissions reset on every rebuild):
```bash
# Override signing identity to force adhoc:
SIGN_IDENTITY="-" ./build.sh
```

---

## Auto-Rebuild on Save (Watch Mode)

`./build.sh run` includes built-in watch mode that automatically rebuilds and relaunches when you save Swift files or resources:

```bash
./build.sh run
```

**How it works:**
1. After the initial build and launch, the script watches for file changes
2. Edit Swift files or resources (.swift, .xcassets) in your editor
3. Save (Cmd+S)
4. App automatically rebuilds and relaunches in ~4 seconds
5. Watch polls every 2 seconds for changes (no external dependencies required)
6. Press Ctrl+C to stop watching

---

## SwiftPM Commands

<details>
<summary><strong>Raw SwiftPM commands</strong></summary>

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

</details>

---

## Test DMG Installer

To preview the DMG installer layout locally (requires `brew install create-dmg`):

```bash
./dmg/test-dmg.sh
```

This builds the app (if needed), generates the background image, creates a styled DMG, and opens it in Finder.

---

## Local Assistant (Daemon)

The macOS app is a frontend — all inference (chat, computer-use sessions, ambient analysis) goes through the **local assistant process** (internally called the daemon), a backend process that manages LLM API calls, conversation state, and tool execution. The app connects to it via HTTP+SSE (the runtime HTTP server port is resolved dynamically from the lockfile, honoring `BASE_DATA_DIR` for multi-instance setups).

**Local mode: You must start the assistant before using the app.** Without it, the app will connect but get no responses. (In managed mode, the assistant runs on the Vellum platform — no local process needed.)

```bash
# Recommended: use the vellum CLI (starts daemon + gateway)
vellum wake

# Check process status
vellum ps

# Stop everything
vellum sleep
```

For low-level development, you can also start the daemon directly:

```bash
cd assistant && bun run src/index.ts daemon start
```

The app will auto-reconnect if the assistant process restarts.

> **Multi-instance note:** The default data directory is `~/.vellum/`. When `BASE_DATA_DIR` is set or multiple instances are configured via the lockfile, paths resolve to the instance-specific directory instead. See `DaemonClient.resolveSocketPath()` for resolution logic.

---

## Permissions

The app requires three macOS permissions:
- **Accessibility** — For reading UI element trees and injecting mouse/keyboard events
- **Screen Recording** — For capturing screenshots (vision fallback when AX tree is sparse)
- **Microphone** — For voice input via speech recognition

Grant these in System Settings → Privacy & Security.

---

## Usage

1. Launch the app — an onboarding flow guides you through permissions and setup on first run
2. The app appears as a sparkles icon in your menu bar
3. Open Settings (click icon → gear) and enter your Anthropic API key (local mode only)
4. Click the menu bar icon or press `⌘⇧G` to open the task input
5. Type a task (e.g., "Fill in the name field with John Smith") and press Go
6. Or hold the Fn key to dictate a task via voice
7. Watch the overlay as vellum-assistant works through the task
8. Press Escape at any time to cancel
9. The main window shows a chat interface — type a message to start a conversation
10. Responses stream in real-time from the assistant
11. Click the stop button to cancel an in-progress generation

### Keyboard Shortcuts

<details>
<summary><strong>Keyboard shortcuts reference</strong></summary>

| Shortcut | Action |
|----------|--------|
| `Cmd +` | Conversation zoom in (text only) |
| `Cmd -` | Conversation zoom out (text only) |
| `Cmd 0` | Reset conversation zoom to 100% |
| `Option+Cmd +` | Window zoom in (entire UI) |
| `Option+Cmd -` | Window zoom out (entire UI) |
| `Option+Cmd 0` | Reset window zoom to 100% |
| `Cmd Shift G` | Open task input popover |
| `Escape` | Cancel current session / close popover |

**Conversation zoom** scales chat text (messages, markdown, code blocks, composer) independently of the window. A brief "Text 125%" indicator appears on each change. The zoom level persists across app relaunches.

**Window zoom** scales the entire UI uniformly. A percentage indicator appears at the top of the window on each change.

</details>

### Opportunistic Message Queueing

Users can send multiple messages while the assistant is busy. Messages are queued (FIFO, max 10) and processed automatically:

- The queue drains at safe tool-loop checkpoints, not just at full completion
- UI shows queue status: "N messages queued, sending automatically"
- Message bubbles show status: queued (dimmed) -> processing -> sent
- The assistant emits `generation_handoff` when it yields to queued work at a checkpoint, followed by `message_dequeued` as each queued message begins processing

**Current limitations:** Text-only messages, no conversation history browser.

### Tool Permission Tester

In Settings > Trust, engineers can simulate whether a tool invocation would be allowed, denied, or prompted. The tester shows the same `ToolConfirmationBubble` UI used in chat. "Allow Once" and "Don't Allow" are simulation-only; "Always Allow" persists a real trust rule.

---

## Component Gallery (Debug)

Use Component Gallery as the visual verification surface for UI components. Do not add `#Preview` / `PreviewProvider` blocks.

### Prerequisites

1. **Install Xcode** — Download from the [Mac App Store](https://apps.apple.com/us/app/xcode/id497799835) (free, requires macOS). It's a large download (~7 GB), so this may take a while.
2. **Open Xcode once** after installing and accept the license agreement. It will install additional components automatically.

<details>
<summary><strong>Step-by-step: Opening the project</strong></summary>

1. Open Terminal and run:
   ```bash
   # From the clients/macos/ directory:
   open ../Package.swift

   # Or from the repo root:
   open clients/Package.swift
   ```
   This opens the Swift package in Xcode. The Package.swift lives in the `clients/` directory and contains both macOS and iOS targets.

2. Xcode will open and start resolving dependencies (you'll see a spinner in the top status bar). Wait for it to finish — this only takes a few seconds.

</details>

<details>
<summary><strong>Step-by-step: Opening Component Gallery</strong></summary>

1. **Run a debug build of `vellum-assistant`.**
   In Xcode, use the `vellum-assistant` scheme and run on `My Mac`.

2. **Open the menu bar app menu.**
   Click the Vellum menu bar icon, then choose **Component Gallery**.

3. **Validate components in Gallery.**
   Verify variants/states in the appropriate section (`Gallery/Sections/`).

4. **Keep Gallery updated with code changes.**
   When adding or changing design system components, update Gallery sections instead of adding preview blocks.

</details>

### Troubleshooting

| Problem | Fix |
|---------|-----|
| "Component Gallery" menu item is missing | Run a **Debug** build (`#if DEBUG` menu item) |
| Changed component does not appear in Gallery | Update the relevant file in `clients/shared/DesignSystem/Gallery/Sections/` |
| Gallery build errors | Fix compile errors in component code, then rerun the app |

---

## Architecture

<details>
<summary><strong>Full directory layout</strong></summary>

```
App/                  AppDelegate, menu bar setup, permissions, voice input
vellum-assistant-app/ Entry point (@main VellumAssistantApp — thin wrapper)
ComputerUse/          Core perception + action pipeline
  AccessibilityTree   AX element enumeration & formatting
  AXTreeDiff          Diff between AX tree snapshots across steps
  ActionExecutor      CGEvent mouse/keyboard injection
  ActionTypes         Action type definitions
  ActionVerifier      Safety checks (sensitive data, loops, limits)
  HostCuExecutor      Computer-use action execution
  HostCuSessionProxy  Session proxy for host computer-use orchestration
  ScreenCapture       ScreenCaptureKit screenshot capture
Services/             Singleton service containers
Ambient/              Background screen-watching agent
  AmbientAgent        Periodic capture → OCR → analyze via HTTP
  AmbientAXCapture    Accessibility tree capture for ambient analysis
  KnowledgeStore      Persists observations as JSON
  ScreenOCR           Vision framework OCR
  WatchSession        Watch connectivity session for ambient data
Features/
  Avatar/             Avatar customization
  Chat/               Chat interface (ChatView, ChatViewModel, ChatMessage)
  CommandPalette/     Command palette (search, actions)
  Contacts/           Contact management
  ChannelVerification/ Channel verification flow
  MainWindow/         Main window shell, ConversationSwitcherDrawer, ConversationManager, PanelCoordinator, side panels
  Onboarding/         First-launch setup flow (permissions, naming, Fn key)
  QuickInput/         Quick task input popover and screen selection
  Session/            Session overlay UI for computer-use task execution
  Settings/           Tabbed settings panels (Appearance, Advanced, Connect, Trust, etc.)
  Sharing/            Content sharing and export
  Surfaces/           Daemon surface rendering (HTML/JSON overlays)
  Terminal/            Terminal UI
  Voice/              Voice input UI (VoiceTranscriptionWindow)
Recording/            Screen recording (HUD, capture, thumbnails)
Telemetry/            Crash reporting, MetricKit, perf signposts
Security/             Keychain broker
Logging/
  TraceStore          In-memory trace event store (per-session, dedup, retention cap)
  Session recording   JSON logs to ~/Library/App Support/
```

</details>

---

## Remote Assistant

The app supports connecting to a remote assistant process over HTTP. Configure a remote assistant entry in the lockfile with its `runtimeUrl` and optional `bearerToken`, or use managed mode to connect through the Vellum platform. See the [Remote Access](../../README.md#remote-access) section in the root README.

---

## Safety

- Credit cards, SSNs, and passwords are blocked at the verifier level
- Destructive key combos (Cmd+Q, Cmd+W, Cmd+Delete) require explicit user confirmation
- Form submission (Enter after typing) requires confirmation
- Loop detection aborts stuck agents (3 identical consecutive actions)
- Step limit enforced (default 50, configurable)
- System menu bar (top 25px) is off-limits
- Escape key or Stop button instantly cancels
