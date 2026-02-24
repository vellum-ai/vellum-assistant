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

Requires the Vellum daemon running on your Mac (via the macOS desktop app or `cd assistant && bun run src/index.ts daemon start` from the repo root). The iOS app connects to the daemon through an HTTP gateway using a bearer token for authentication.

**QR Code Pairing (recommended):**

1. On your Mac, open **Settings → Connect → Show QR Code**
2. On your iPhone, go to **Settings → Connect → Scan QR Code**
3. Scan the QR code — the app auto-configures the gateway URL and bearer token

The QR code contains a v3 payload with the gateway URL, bearer token, and local network settings. For LAN-only connections (e.g., development), the QR code includes an `allowLocalHttp` flag that permits plain HTTP for local/private addresses.

**Manual Setup:**

1. On your iPhone, go to **Settings → Connect → Manual Setup**
2. Enter the gateway URL shown in your Mac's **Settings → Connect → Gateway** section
3. Enter the bearer token shown in your Mac's **Settings → Connect → Advanced** section
4. Tap **Connect**

HTTPS is required for non-local connections. HTTP is permitted only for loopback, mDNS `.local`, link-local, and RFC 1918 private addresses.

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

| Setting | Storage | Default | Description |
|---------|---------|---------|-------------|
| Gateway URL | UserDefaults `gateway_base_url` | — | HTTP(S) gateway URL from QR code or manual entry |
| Bearer token | Keychain (device) / UserDefaults (sim), provider `"runtime-bearer-token"` | — | Authentication token for gateway requests |
| Conversation key | UserDefaults `conversation_key` | — | Auto-generated UUID for session identification |
| Anthropic API key | Keychain (device) / UserDefaults (sim) | — | For standalone mode (direct API) |
| Daemon hostname | UserDefaults `daemon_hostname` | `localhost` | Legacy TCP hostname (still used for cert pinning) |
| Daemon port | UserDefaults `daemon_port` | `8765` | Legacy TCP port |

## Dependencies

The iOS app depends only on `VellumAssistantShared`. It must **not** import `VellumAssistantLib`, which links macOS-only frameworks (AppKit, ScreenCaptureKit, etc.).

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Cannot connect" | Daemon not running or wrong gateway URL | Start the macOS app, verify gateway URL in Settings → Connect |
| "Connection failed" after QR scan | Gateway unreachable from iPhone | Ensure both devices are on the same network; check firewall settings |
| "HTTPS is required" on manual entry | Non-local URL with `http://` scheme | Use `https://` or connect via QR code for local HTTP |
| Auth timeout / immediate disconnect | Missing or wrong bearer token | Re-scan QR code or re-enter token from Mac's Settings → Connect → Advanced |
| "Failed to save API Key" | Keychain unavailable (simulator) | Expected — key saved to UserDefaults instead |
| Old version still showing in simulator | Cached build | `xcrun simctl uninstall <UDID> ai.vellum.assistant.ios` then reinstall |
