# Clients Directory

This directory contains native client applications for the Vellum Assistant, organized for code reuse between platforms.

For client architecture details, see [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Structure

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
└── ios/                       # iOS-specific code
    ├── App/                   # App lifecycle (VellumAssistantApp, AppDelegate, VellumIntents, etc.)
    ├── Views/                 # iOS-specific SwiftUI views (ChatTabView, ThreadListView, etc.)
    │   └── Settings/          # Decomposed settings sections (Integrations, TrustRules, etc.)
    ├── Tests/                 # iOS integration tests (70 tests)
    └── Resources/             # Assets, Info.plist, background.png
```

## Targets

### VellumAssistantShared (Library)
**Platforms**: macOS 14+, iOS 17+
**Purpose**: Platform-agnostic code shared between macOS and iOS apps

**Contains**:
- **IPC layer** (`DaemonClient`, `IPCMessages`, `Generated/IPCContractGenerated`) - Network communication with the assistant
  - macOS: Unix domain socket (`~/.vellum/vellum.sock`)
  - iOS: TCP connection (configurable hostname:port)
  - Wire types are auto-generated from the TS IPC contract; `IPCMessages.swift` provides
    typealiases, convenience inits, the `ServerMessage` routing enum, and a few hand-maintained
    types that need Swift-specific logic (e.g. typed enums, polymorphic `AnyCodable` data)
- **Shared chat features** (`ChatViewModel`, `ChatMessage`, `MessageBubbleView`, `InputBarView`, `AttachmentStripView`, `MarkdownRenderer`, `CurrentStepIndicator`, inline widgets)
- **Design system** (`VColor`, `VFont`, `VSpacing`, `VRadius`, `VShadow`, `VAnimation`, and all `V`-prefixed components)
- **Shared utilities** (`APIKeyManager` for Keychain credential storage, `PermissionManager`, `MacOSClientFeatureFlagManager`)
- **Shared app utilities** (signing identity management)

**Dependencies**: None (only system frameworks: Network, Security)

### VellumAssistantLib (Library)
**Platforms**: macOS 14+ only
**Purpose**: macOS application logic

**Contains**:
- UI (AppKit views, panels, overlays)
- Computer-use features (accessibility, screen capture, input injection)
- macOS-specific integrations (menu bar, hotkeys, voice input)

**Dependencies**: VellumAssistantShared, HotKey, Sparkle
**Frameworks**: AppKit, ScreenCaptureKit, ApplicationServices, Vision, Speech

**⚠️ iOS apps should NOT depend on this target** - it links macOS-only frameworks.

### vellum-assistant (Executable)
**Platforms**: macOS 14+
**Purpose**: Thin entry point for macOS app

**Contains**: Just `@main` app delegate setup
**Dependencies**: VellumAssistantLib

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
- ✅ Standalone mode — direct Anthropic API connection (no Mac required)
- ✅ Connected to Mac mode — TCP proxy through the Vellum assistant
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
- ✅ 70 integration tests (ChatViewModel, threads, attachments, formatting)

Depends only on `VellumAssistantShared` (no macOS frameworks).

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

## Known Limitations

### iOS Signing Operations
- iOS clients log errors when assistant sends signing requests (macOS-specific IPC)
- Cannot send error responses (protocol limitation)

### iOS TCP — Real Device Networking
- `localhost` only works in the simulator (simulator shares Mac's network stack)
- For real device: enter Mac's local IP in Settings → Mac Assistant → Hostname
- For remote access: requires VPN, SSH tunnel, or port forwarding

### iOS Computer-Use
- AXUIElement + CGEvent APIs are macOS-only (sandbox prevents on iOS)
- Computer-use sessions initiated from iOS proxy through the Mac assistant

## Documentation

- **macOS development**: See `clients/macos/CLAUDE.md`
- **iOS development**: See `clients/ios/README.md`

### Docs Checks

A sanity-check script catches known stale documentation patterns (outdated transport wording, hardcoded test counts, stale dependency claims). It runs automatically in CI on PRs that touch client docs.

```bash
# Run locally from the repo root:
./scripts/check-client-docs.sh
```

To extend the checks, add new `check_absent` calls to the script. Keep patterns narrowly scoped to avoid false positives.

## Testing

```bash
cd clients/macos
./build.sh test     # All SPM tests (shared + macOS-specific)
```

### iOS Integration Tests

```bash
cd clients/ios
./build.sh test    # 70 iOS-specific tests (via xcodebuild)
```

Test files in `clients/ios/Tests/`:
- `ChatViewModelIOSTests.swift` — send/receive flow, streaming, error handling
- `ThreadLifecycleIOSTests.swift` — session creation, thread isolation
- `ChatTranscriptFormatterIOSTests.swift` — markdown formatting
- `AttachmentFlowIOSTests.swift` — attachment limits, send flow, thumbnails

Tests use mock implementations of protocols for dependency injection:
- `DaemonClientProtocol` → `MockDaemonClient`
- `AccessibilityTreeProviding` → `MockAccessibilityTree`
- `ScreenCaptureProviding` → `MockScreenCapture`
