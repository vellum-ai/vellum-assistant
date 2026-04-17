# iOS App — vellum-assistant-ios

The iOS app is built via a native Xcode project (`vellum-assistant-ios.xcodeproj`) generated from `project.yml` using XcodeGen. It depends on `VellumAssistantShared` from the local SPM package at `clients/Package.swift`.

After editing `project.yml`, regenerate the Xcode project by running `xcodegen generate` from the `clients/ios/` directory.

---

## Features

- **Cloud login** — sign in with Vellum to connect to a platform-hosted assistant
- Chat interface with streaming responses, markdown rendering, and code blocks
- Conversation list with persistence, search, rename, timestamps, and archive
- Push notifications for assistant replies (APNS)
- Voice input with service-first STT (gateway → configured provider) and Apple-native fallback (`SpeechRecognizerAdapter`)
- Export conversation as markdown (copy to clipboard or share sheet)
- Deep linking via `vellum://send?message=...` URL scheme

---

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

---

## Connection

The iOS app signs in with Vellum to connect to a platform-hosted assistant.

1. Launch the app → complete onboarding → tap **"Log in with Vellum"**
2. Authenticate via WorkOS in the system browser
3. The app connects to your platform-hosted assistant automatically

No API key or local assistant is required — the assistant runs on the Vellum platform. Session tokens are stored in the Keychain and refreshed automatically.

**Note for simulator:** Keychain is unavailable for unsigned simulator builds. Tokens are stored in `UserDefaults` instead, which works fine for development. On a real device, credentials are stored in the Keychain.

---

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
- `ConversationLifecycleIOSTests.swift` — session creation, backfill, conversation isolation

### Shared Tests

The `VellumAssistantSharedTests` target covers shared network logic and can be run on macOS without a simulator:

```bash
cd clients/macos
./build.sh test
```

Or directly via SPM from the `clients/` directory:

```bash
cd clients
swift test --filter VellumAssistantSharedTests
```

---

## Configuration Reference

<details>
<summary><strong>Configuration settings</strong></summary>

| Setting | Storage | Default | Description |
|---------|---------|---------|-------------|
| Gateway URL | UserDefaults `gateway_base_url` | — | HTTP(S) gateway URL from QR code pairing |
| Bearer token | Keychain (device) / UserDefaults (sim), provider `"runtime-bearer-token"` | — | Authentication token for gateway requests |
| Device ID | Keychain (device) / UserDefaults (sim), provider `"pairing-device-id"` | — | Stable UUID for pairing identity (survives reinstalls) |
| Conversation key | UserDefaults `conversation_key` | — | Auto-generated UUID for session identification |
| Session token | Keychain via `AuthManager` | — | WorkOS session token for cloud login mode |

</details>

---

## Dependencies

The iOS app depends only on `VellumAssistantShared`. It must **not** import `VellumAssistantLib`, which links macOS-only frameworks (AppKit, ScreenCaptureKit, etc.).

---

## Speech Recognition (STT)

Voice input uses a **service-first STT** strategy. When the user finishes recording, captured audio buffers are encoded to WAV via `AudioWavEncoder` (shared utility) and sent to the assistant's configured STT service through the gateway using `STTClient` (`clients/shared/Network/STTClient.swift`). If the STT service returns a successful transcription, that text is used. If the service is unconfigured (HTTP 503), unavailable, or returns an empty result, the native `SFSpeechRecognizer` transcript is used as fallback.

During recording, the `SpeechRecognizerAdapter` protocol (`Services/SpeechRecognizerAdapter.swift`) provides real-time partial transcriptions via Apple's on-device `SFSpeechRecognizer` for immediate display in the input bar. The production implementation (`AppleSpeechRecognizerAdapter`) delegates to `SFSpeechRecognizer`. `InputBarView` consumes both the adapter (for partials and fallback) and `STTClient` (for service-first resolution) via stored properties, enabling tests to substitute mocks without a live microphone or OS permission dialogs.

---

## Troubleshooting

<details>
<summary><strong>Common issues and fixes</strong></summary>

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Cannot connect" | Assistant not running or wrong gateway URL | Start the macOS app, verify gateway URL in Settings → Connect |
| "Connection failed" after QR scan | Gateway unreachable from iPhone | Ensure both devices are on the same network; check firewall settings |
| "Pairing was denied" | User tapped Deny on Mac | Show a new QR code and approve the pairing |
| "Pairing request expired" | QR code older than 5 minutes | Show a new QR code on your Mac |
| "This QR code is outdated" | Scanned a v2/v3 QR code | Update Vellum on your Mac and generate a new QR code |
| Auth timeout / immediate disconnect | Missing or wrong bearer token | Re-scan QR code to obtain a fresh token |
| "Failed to save API Key" | Keychain unavailable (simulator) | Expected — key saved to UserDefaults instead |
| Old version still showing in simulator | Cached build | `xcrun simctl uninstall <UDID> ai.vocify-inc.vellum-assistant-ios` then reinstall |

</details>
