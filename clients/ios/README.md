# iOS App — vellum-assistant-ios

The iOS app is built via a native Xcode project (`vellum-assistant-ios.xcodeproj`) generated from `project.yml` using XcodeGen. It depends on `VellumAssistantShared` from the local SPM package at `clients/Package.swift`.

## Features

- **Standalone mode** — connects directly to Anthropic API using your API key (no Mac required)
- **Connected to Mac mode** — connects through the HTTP gateway with bearer token authentication
- Chat interface with streaming responses, markdown rendering, and code blocks
- Multiple threads with persistence, search, rename, timestamps, and archive
- Assistant-synced threads in Connected mode (shared with macOS)
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

Requires the Vellum assistant running on your Mac (via the macOS desktop app or `vellum wake` from the CLI). The iOS app connects through the HTTP gateway using a bearer token for authentication.

**QR Code Pairing:**

1. On your Mac, open **Settings → Connect → Show QR Code**
2. On your iPhone, go to **Settings → Connect → Scan QR Code**
3. Scan the QR code — your Mac will show an approval prompt
4. Tap **Approve Once** or **Always Allow** on your Mac
5. The app auto-configures the gateway URL and bearer token

The QR code uses a v4 payload with a one-time pairing secret (no bearer token in the QR). All pairings require Mac-side approval. Devices approved with "Always Allow" auto-approve on future pairings. LAN pairing works automatically when both devices are on the same network — the QR code includes the local gateway URL for direct LAN connections.

## Running Tests

### iOS Integration Tests

The `vellum-assistant-iosTests` target contains iOS-specific integration tests:

```bash
cd clients/ios
./build.sh test
```

Test files in `clients/ios/Tests/`:
- `AttachmentFlowIOSTests.swift` — attachment limits, send flow, thumbnails
- `ChatTranscriptFormatterIOSTests.swift` — markdown formatting, plain text extraction
- `ChatViewModelIOSTests.swift` — message send/receive flow, streaming, error handling
- `ThreadLifecycleIOSTests.swift` — session creation, backfill, thread isolation
- `UsageDashboardViewTests.swift` — usage dashboard state, data loading, formatting

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
| Gateway URL | UserDefaults `gateway_base_url` | — | HTTP(S) gateway URL from QR code pairing |
| Bearer token | Keychain (device) / UserDefaults (sim), provider `"runtime-bearer-token"` | — | Authentication token for gateway requests |
| Device ID | Keychain (device) / UserDefaults (sim), provider `"pairing-device-id"` | — | Stable UUID for pairing identity (survives reinstalls) |
| Conversation key | UserDefaults `conversation_key` | — | Auto-generated UUID for session identification |
| Anthropic API key | Keychain (device) / UserDefaults (sim) | — | For standalone mode (direct API) |

## Dependencies

The iOS app depends only on `VellumAssistantShared`. It must **not** import `VellumAssistantLib`, which links macOS-only frameworks (AppKit, ScreenCaptureKit, etc.).

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Cannot connect" | Assistant not running or wrong gateway URL | Start the macOS app, verify gateway URL in Settings → Connect |
| "Connection failed" after QR scan | Gateway unreachable from iPhone | Ensure both devices are on the same network; check firewall settings |
| "Pairing was denied" | User tapped Deny on Mac | Show a new QR code and approve the pairing |
| "Pairing request expired" | QR code older than 5 minutes | Show a new QR code on your Mac |
| "This QR code is outdated" | Scanned a v2/v3 QR code | Update Vellum on your Mac and generate a new QR code |
| Auth timeout / immediate disconnect | Missing or wrong bearer token | Re-scan QR code to obtain a fresh token |
| "Failed to save API Key" | Keychain unavailable (simulator) | Expected — key saved to UserDefaults instead |
| Old version still showing in simulator | Cached build | `xcrun simctl uninstall <UDID> ai.vellum.assistant.ios` then reinstall |
