# iOS App — vellum-assistant-ios

The iOS app is built via a native Xcode project (`vellum-assistant-ios.xcodeproj`) generated from `project.yml` using XcodeGen. It depends on `VellumAssistantShared` from the local SPM package at `clients/Package.swift`.

## Features

- **Standalone mode** — connects directly to Anthropic API using your API key (no Mac required)
- **Connected to Mac mode** — proxies through the Vellum daemon running on your Mac over TCP
- Chat interface with streaming responses, markdown rendering, and code blocks
- Multiple threads with persistence, search, rename, timestamps, and archive
- Daemon-synced threads in Connected mode (shared with macOS)
- Model picker, model list, and command list rendering (shared components)
- Subagent status chips with real-time state updates
- Skill invocation chips in message bubbles
- Compact used tools list with expandable step details
- Inline media embeds (images, YouTube, Vimeo, Loom videos)
- Settings: integrations, trust rules, scheduled tasks, reminders (Connected mode)
- Attachment support (photos, files)
- Voice input via `SFSpeechRecognizer`
- Onboarding flow with adaptive steps based on connection mode
- Export conversation as markdown (copy to clipboard or share sheet)
- Siri Shortcuts integration — "Ask Vellum..." via AppIntents framework
- Deep linking via `vellum://send?message=...` URL scheme
- Responsive typography and spacing that scales down for iPhone compact width

## Build & Test

Single build script: `./build.sh` wraps `xcodebuild` using the native `.xcodeproj`.

```bash
# Build debug (simulator)
./build.sh

# Build release .ipa for TestFlight
DEVELOPMENT_TEAM=XXXXXXXXXX ./build.sh release

# Run iOS tests
./build.sh test

# Clean build artifacts
./build.sh clean
```

Environment variables for CI:

| Variable | Default | Description |
|----------|---------|-------------|
| `DEVELOPMENT_TEAM` | *(required for release)* | Apple team ID |
| `DISPLAY_VERSION` | from `Package.swift` | CFBundleShortVersionString |
| `BUILD_VERSION` | `1` | CFBundleVersion |

### Building with Xcode (development)

1. Open `clients/ios/vellum-assistant-ios.xcodeproj` in Xcode
2. Select the `VellumAssistantIOS` scheme
3. Choose an iOS Simulator as destination (e.g. iPhone 16 Pro)
4. Build and Run (Cmd+R)

### Building via command line (simulator)

```bash
cd clients/ios
./build.sh
```

## Connection Modes

### Standalone Mode (no Mac required)

1. Launch the app → complete onboarding → choose **"Standalone"**
2. Enter your [Anthropic API key](https://console.anthropic.com/) when prompted
3. Start chatting — the app calls the Anthropic API directly

**Note for simulator:** Keychain is unavailable for unsigned simulator builds. API keys are stored in `UserDefaults` instead, which works fine for development. On a real device, keys are stored in the Keychain.

### Connected to Mac Mode

Requires the Vellum daemon running on your Mac (either as the macOS desktop app or `bun run src/daemon/main.ts`).

**In the simulator** (same machine as Mac):

1. Choose **"Connect to Mac"** in onboarding
2. Hostname: `localhost`, Port: `8765`
3. Get the session token from your Mac:
   ```bash
   cat ~/.vellum/session-token
   ```
4. Paste the token into the Session Token field

**On a real iPhone** (same Wi-Fi network):

1. Find your Mac's local IP:
   - System Settings → Network → Wi-Fi → Details → IP Address
   - Or run `ipconfig getifaddr en0` in Terminal
2. Use that IP as the hostname (e.g. `192.168.1.42`)
3. Copy the session token from Mac app **Settings → iOS Device → Copy** (or `~/.vellum/session-token`)

**Starting the daemon with TCP enabled:**
```bash
cd assistant
# For simulator (localhost only):
VELLUM_DAEMON_TCP_ENABLED=1 bun run src/index.ts daemon start

# For real device (all network interfaces):
VELLUM_DAEMON_TCP_ENABLED=1 VELLUM_DAEMON_TCP_HOST=0.0.0.0 bun run src/index.ts daemon start
```

TCP is opt-in (`VELLUM_DAEMON_TCP_ENABLED=1`) for security — the Unix socket default binds only to the local filesystem. By default the TCP listener binds to `127.0.0.1` (simulator use). Set `VELLUM_DAEMON_TCP_HOST=0.0.0.0` to accept LAN connections from a real device.

The macOS app sets `VELLUM_DAEMON_TCP_ENABLED=1` automatically when the daemon starts.

## Running Tests

### iOS Integration Tests

The `vellum-assistant-iosTests` target contains 70 iOS-specific integration tests:

```bash
cd clients/ios
./build.sh test
```

Test files in `clients/ios/Tests/`:
- `ChatViewModelIOSTests.swift` — message send/receive flow, streaming, error handling (30 tests)
- `ThreadLifecycleIOSTests.swift` — session creation, backfill, thread isolation (12 tests)
- `ChatTranscriptFormatterIOSTests.swift` — markdown formatting, plain text extraction (11 tests)
- `AttachmentFlowIOSTests.swift` — attachment limits, send flow, thumbnails (17 tests)

### Shared Tests

The `VellumAssistantSharedTests` target covers shared IPC logic and can be run on macOS without a simulator:

```bash
cd clients/macos
./build.sh test
```

Or directly via SPM from the `clients/` directory:

```bash
cd clients
swift test --filter VellumAssistantSharedTests
```

## Configuration Reference

| Setting | UserDefaults Key | Default | Description |
|---------|-----------------|---------|-------------|
| Connection mode | `connection_mode` | `Standalone` | `Standalone` or `Connected to Mac` |
| Daemon hostname | `daemon_hostname` | `localhost` | Mac hostname or IP |
| Daemon port | `daemon_port` | `8765` | Daemon TCP port |
| Session token | Keychain (device) / UserDefaults (simulator), provider key `"daemon-token"` | — | Token from `~/.vellum/session-token` on Mac |
| Use TLS | `daemon_tls_enabled` | `false` | Enable TLS for TCP connection |
| Anthropic API key | (UserDefaults on simulator, Keychain on device) | — | For standalone mode |

## Dependencies

The iOS app depends only on `VellumAssistantShared`. It must **not** import `VellumAssistantLib`, which links macOS-only frameworks (AppKit, ScreenCaptureKit, etc.).

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Cannot connect to daemon" | Daemon not running or wrong hostname/port | Start daemon, verify `localhost:8765` in simulator |
| Auth timeout / immediate disconnect | Missing or wrong session token | Copy from `~/.vellum/session-token` on Mac |
| "Failed to save API Key" | Keychain unavailable (simulator) | Expected — key saved to UserDefaults instead |
| Old version still showing in simulator | Cached build | `xcrun simctl uninstall <UDID> ai.vellum.assistant.ios` then reinstall |
