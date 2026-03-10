# Clients Directory

This directory contains native client applications for the Vellum Assistant, organized for code reuse between platforms.

For client architecture details, see [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Structure

<details>
<summary><strong>Directory layout</strong></summary>

```
clients/
├── Package.swift              # Multi-platform Swift Package Manager manifest
├── shared/                    # VellumAssistantShared - cross-platform code
│   ├── IPC/                   # Daemon communication (DaemonClient, DaemonConfig, IPCMessages)
│   ├── Features/Chat/         # Shared chat UI (ChatViewModel, MessageBubbleView, InputBarView, etc.)
│   ├── Features/Surfaces/     # Shared surface rendering (confirmation, form)
│   ├── DesignSystem/          # Design tokens and components (VColor, VFont, VSpacing, etc.)
│   ├── Utilities/             # Shared utilities (APIKeyManager, PermissionManager)
│   └── App/                   # Shared app utilities (SigningIdentityManager)
├── macos/                     # macOS-specific code
│   ├── vellum-assistant/      # VellumAssistantLib - macOS app logic
│   ├── vellum-assistant-app/  # Executable entry point
│   ├── build.sh               # Build script (wraps SPM → .app → codesign)
│   └── CLAUDE.md              # Development guide for Claude Code
├── ios/                       # iOS-specific code
│   ├── App/                   # App lifecycle (VellumAssistantApp, AppDelegate, VellumIntents, etc.)
│   ├── Views/                 # iOS-specific SwiftUI views (ChatTabView, ThreadListView, etc.)
│   │   └── Settings/          # Decomposed settings sections (Integrations, TrustRules, etc.)
│   ├── Tests/                 # iOS integration tests
│   └── Resources/             # Assets, Info.plist, background.png
└── chrome-extension/          # Chrome browser extension
```

</details>

---

## Targets

### VellumAssistantShared (Library)
**Platforms**: macOS 14+, iOS 17+
**Purpose**: Platform-agnostic code shared between macOS and iOS apps

**Contains**:
- **Network layer** (`DaemonClient`, `IPCMessages`, `Generated/GeneratedAPITypes`) - HTTP+SSE communication with the assistant
  - macOS: HTTP+SSE to the local daemon runtime server
  - iOS: HTTP+SSE through the gateway
  - Wire types are auto-generated from the TS contract; `IPCMessages.swift` provides
    typealiases, convenience inits, the `ServerMessage` routing enum, and a few hand-maintained
    types that need Swift-specific logic (e.g. typed enums, polymorphic `AnyCodable` data)
- **Shared chat features** (`ChatViewModel`, `ChatMessage`, `MessageBubbleView`, `InputBarView`, `AttachmentStripView`, `MarkdownRenderer`, `CurrentStepIndicator`, inline widgets)
- **Design system** (`VColor`, `VFont`, `VSpacing`, `VRadius`, `VShadow`, `VAnimation`, and all `V`-prefixed components)
- **Shared utilities** (`APIKeyManager` for Keychain credential storage, `PermissionManager`, `MacOSClientFeatureFlagManager`)
- **Shared app utilities** (signing identity management)

**Dependencies**: None (only system frameworks: AuthenticationServices, Network, Security)

### VellumAssistantLib (Library)
**Platforms**: macOS 14+ only
**Purpose**: macOS application logic

**Contains**:
- UI (AppKit views, panels, overlays)
- Computer-use features (accessibility, screen capture, input injection)
- macOS-specific integrations (menu bar, hotkeys, voice input)

**Dependencies**: VellumAssistantShared, Sentry, Sparkle
**Frameworks**: AppKit, ApplicationServices, AuthenticationServices, AVKit, CoreGraphics, Network, ScreenCaptureKit, Security, Speech, SpriteKit, Vision

**⚠️ iOS apps should NOT depend on this target** - it links macOS-only frameworks.

### vellum-assistant (Executable)
**Platforms**: macOS 14+
**Purpose**: Thin entry point for macOS app

**Contains**: Just `@main` app delegate setup
**Dependencies**: VellumAssistantLib

---

## Building

### macOS App
```bash
cd clients/macos
./build.sh          # Build debug .app
./build.sh run      # Build + launch
./build.sh release  # Build release
./build.sh test     # Run tests
./build.sh clean    # Remove artifacts
```

The build script:
1. Runs `swift build` from `clients/macos/` (SPM finds `../Package.swift` automatically)
2. Packages binary into `dist/Vellum.app` bundle
3. Codesigns with ad-hoc signature (or release identity)

### iOS App

**Option A: Xcode** (recommended)
```bash
cd clients/ios
open vellum-assistant-ios.xcodeproj
# Xcode: Select VellumAssistantIOS scheme
# Choose iOS Simulator (e.g., iPhone 16 Pro)
# Run (⌘R)
```

**Option B: command line**
```bash
cd clients/ios
./build.sh
```

See [clients/ios/README.md](ios/README.md) for full build, packaging, and configuration instructions.

**Current features:**
- ✅ Cloud login — sign in with Vellum to connect to a platform-hosted assistant (no Mac required)
- ✅ Connect to assistant — pair via QR code (HTTP+SSE through the gateway with bearer token authentication)
- ✅ Chat interface with streaming, markdown, code blocks
- ✅ Multiple threads with JSON persistence
- ✅ Onboarding with adaptive steps per connection mode
- ✅ Voice input
- ✅ Attachment support (photos, files)
- ✅ Settings with live client switching (no restart needed)
- ✅ Push notifications (APNS + rich inline reply)
- ✅ Export conversation (copy as markdown or share sheet)
- ✅ Siri Shortcuts ("Ask Vellum..." via AppIntents)
- ✅ Deep linking (`vellum://send?message=...`)
- ✅ Responsive typography/spacing (compact scaling for iPhone, full size on iPad)
- ✅ Integration tests (ChatViewModel, threads, attachments, formatting, usage dashboard)

Depends only on `VellumAssistantShared` (no macOS frameworks).

---

## Code Reuse Strategy

**~45-50% code reuse** between macOS and iOS achieved through:

1. **Shared IPC layer** - Both platforms communicate with the assistant (different transport)
2. **Shared design system** - Tokens and components with conditional compilation
3. **Shared ViewModels** - ChatViewModel, message models work on both platforms

**Platform-specific**:
- **UI frameworks**: AppKit (macOS) vs UIKit (iOS)
- **Computer-use**: AXUIElement + CGEvent (macOS only, sandboxing prevents on iOS)
- **Screen recording**: ScreenCaptureKit (macOS) vs ReplayKit (iOS)
- **App lifecycle**: NSStatusItem (macOS) vs UIScene (iOS)

---

## Development

### Adding Shared Code
1. Place platform-agnostic code in `clients/shared/`
2. Mark all types as `public` (cross-module access)
3. Add explicit `public init()` to all structs (memberwise inits are internal)
4. Use `#if os(macOS)` / `#elseif os(iOS)` for platform-specific code

### Adding macOS-Only Code
1. Place in `clients/macos/vellum-assistant/`
2. Import `VellumAssistantShared` for access to IPC types
3. Can use AppKit, ScreenCaptureKit, etc. freely

### Adding iOS Code
1. Place in `clients/ios/App/` (app lifecycle) or `clients/ios/Views/` (UI)
2. Import `VellumAssistantShared` for IPC, design tokens, ViewModels
3. DO NOT import `VellumAssistantLib` (macOS-only)
4. Use `#if os(iOS)` guards if sharing files with macOS

---

## Known Limitations

### iOS Signing Operations
- iOS clients return explicit error responses when the assistant sends signing requests (macOS-specific IPC)
- Unsupported operations (`signBundlePayload`, `getSigningIdentity`) are logged and answered with an error message rather than silently dropped

### iOS Gateway Networking
- iOS connects to the assistant exclusively via the HTTP gateway
- Pair via QR code (Settings → Connect on both devices); all pairings require Mac-side approval
- LAN pairing is disabled by default for security. To enable, set `VELLUM_ENABLE_INSECURE_LAN_PAIRING=1` on the Mac; when enabled, the QR code includes the local gateway URL for direct LAN connections

### iOS Computer-Use
- AXUIElement + CGEvent APIs are macOS-only (sandbox prevents on iOS)
- Computer-use sessions initiated from iOS proxy through the Mac assistant

---

## Documentation

- **macOS development**: See `clients/macos/CLAUDE.md`
- **iOS development**: See `clients/ios/README.md`

---

## Testing

```bash
cd clients/macos
./build.sh test     # macOS-specific SPM tests (runs swift test --filter vellum_assistantTests)
```

### iOS Integration Tests

```bash
cd clients/ios
./build.sh test    # iOS-specific tests (via xcodebuild)
```

Test files in `clients/ios/Tests/`:
- `AttachmentFlowIOSTests.swift` — attachment limits, send flow, thumbnails
- `ChatTranscriptFormatterIOSTests.swift` — markdown formatting
- `ChatViewModelIOSTests.swift` — send/receive flow, streaming, error handling
- `ThreadLifecycleIOSTests.swift` — session creation, thread isolation
- `UsageDashboardViewTests.swift` — usage dashboard state, data loading, formatting

Tests use mock implementations of protocols for dependency injection:
- `DaemonClientProtocol` → `MockDaemonClient`
- `AccessibilityTreeProviding` → `MockAccessibilityTree`
- `ScreenCaptureProviding` → `MockScreenCapture`
