# Clients Directory

This directory contains native client applications for the Vellum Assistant, organized for code reuse between platforms.

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
    ├── App/                   # App lifecycle (VellumAssistantApp, AppDelegate, UserDefaultsKeys)
    ├── Views/                 # iOS-specific SwiftUI views (ChatTabView, ThreadListView, SettingsView, etc.)
    └── Resources/             # Assets, Info.plist, background.png
```

## Targets

### VellumAssistantShared (Library)
**Platforms**: macOS 14+, iOS 17+
**Purpose**: Platform-agnostic code shared between macOS and iOS apps

**Contains**:
- **IPC layer** (`DaemonClient`, `IPCMessages`, `Generated/IPCContractGenerated`) - Network communication with daemon
  - macOS: Unix domain socket (`~/.vellum/vellum.sock`)
  - iOS: TCP connection (configurable hostname:port)
  - Wire types are auto-generated from the TS IPC contract; `IPCMessages.swift` provides
    typealiases, convenience inits, the `ServerMessage` routing enum, and a few hand-maintained
    types that need Swift-specific logic (e.g. typed enums, polymorphic `AnyCodable` data)
- **Shared chat features** (`ChatViewModel`, `ChatMessage`, `MessageBubbleView`, `InputBarView`, `AttachmentStripView`, `MarkdownRenderer`, `CurrentStepIndicator`, inline widgets)
- **Design system** (`VColor`, `VFont`, `VSpacing`, `VRadius`, `VShadow`, `VAnimation`, and all `V`-prefixed components)
- **Shared utilities** (`APIKeyManager` for Keychain credential storage, `PermissionManager`, `FeatureFlagManager`)
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
cd clients
open Package.swift
# Xcode: Select vellum-assistant-ios scheme
# Choose iOS Simulator (e.g., iPhone 17 Pro Max)
# Run (⌘R)
```

**Option B: command line**
```bash
cd clients
xcodebuild build \
  -scheme vellum-assistant-ios \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max' \
  CODE_SIGNING_ALLOWED=NO \
  -derivedDataPath /tmp/vellum-ios-build
```

See [clients/ios/README.md](ios/README.md) for full build, packaging, and configuration instructions.

**Current features:**
- ✅ Standalone mode — direct Anthropic API connection (no Mac required)
- ✅ Connected to Mac mode — TCP proxy through the Vellum daemon
- ✅ Chat interface with streaming, markdown, code blocks
- ✅ Multiple threads with JSON persistence
- ✅ Onboarding with adaptive steps per connection mode
- ✅ Voice input
- ✅ Attachment support (photos, files)
- ✅ Settings with live client switching (no restart needed)
- ✅ Push notifications (APNS + rich inline reply)

Depends only on `VellumAssistantShared` (no macOS frameworks).

## Code Reuse Strategy

**~45-50% code reuse** between macOS and iOS achieved through:

1. **Shared IPC layer** - Both platforms communicate with daemon (different transport)
2. **Shared design system** (PR 2) - Tokens and components with conditional compilation
3. **Shared ViewModels** (PR 3) - ChatViewModel, message models work on both platforms

**Platform-specific**:
- **UI frameworks**: AppKit (macOS) vs UIKit (iOS)
- **Computer-use**: AXUIElement + CGEvent (macOS only, sandboxing prevents on iOS)
- **Screen recording**: ScreenCaptureKit (macOS) vs ReplayKit (iOS)
- **App lifecycle**: NSStatusItem (macOS) vs UIScene (iOS)

## Migration from Single-Platform

This structure was introduced in PR #1821 (iOS shared library foundation). Before this:
- `clients/macos/Package.swift` - Single-platform package
- `clients/macos/vellum-assistant/IPC/` - macOS-only IPC code

After migration:
- `clients/Package.swift` - Multi-platform package
- `clients/shared/IPC/` - Cross-platform IPC code
- All 25+ IPC message types have `public` access and explicit `public init()`

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
- iOS clients log errors when daemon sends signing requests (macOS-specific IPC)
- Cannot send error responses (protocol limitation)

### iOS TCP — Real Device Networking
- `localhost` only works in the simulator (simulator shares Mac's network stack)
- For real device: enter Mac's local IP in Settings → Mac Daemon → Hostname
- For remote access: requires VPN, SSH tunnel, or port forwarding

### iOS Computer-Use
- AXUIElement + CGEvent APIs are macOS-only (sandbox prevents on iOS)
- Computer-use sessions initiated from iOS proxy through the Mac daemon

## Documentation

- **macOS development**: See `clients/macos/CLAUDE.md`
- **iOS development**: See `clients/ios/README.md`

## Testing

```bash
cd clients/macos
./build.sh test     # All SPM tests (both shared and macOS-specific)
```

Tests use mock implementations of protocols for dependency injection:
- `DaemonClientProtocol` → `MockDaemonClient`
- `AccessibilityTreeProviding` → `MockAccessibilityTree`
- `ScreenCaptureProviding` → `MockScreenCapture`
