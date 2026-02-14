# Clients Directory

This directory contains native client applications for the Vellum Assistant, organized for code reuse between platforms.

## Structure

```
clients/
├── Package.swift              # Multi-platform Swift Package Manager manifest
├── shared/                    # VellumAssistantShared - cross-platform code
│   ├── IPC/                   # Daemon communication (both macOS and iOS)
│   └── App/                   # Shared app utilities
├── macos/                     # macOS-specific code
│   ├── vellum-assistant/      # VellumAssistantLib - macOS app logic
│   ├── vellum-assistant-app/  # Executable entry point
│   ├── build.sh               # Build script (wraps SPM → .app → codesign)
│   └── CLAUDE.md              # Development guide for Claude Code
└── ios/                       # (Future) iOS-specific code
    └── vellum-assistant-ios/  # iOS app (planned in PR 4-6)
```

## Targets

### VellumAssistantShared (Library)
**Platforms**: macOS 14+, iOS 17+
**Purpose**: Platform-agnostic code shared between macOS and iOS apps

**Contains**:
- **IPC layer** (`DaemonClient`, `IPCMessages`) - Network communication with daemon
  - macOS: Unix domain socket (`~/.vellum/vellum.sock`)
  - iOS: TCP connection (configurable hostname:port)
- **Shared utilities** (signing, configuration)

**Dependencies**: None (only system frameworks: Network)

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

### iOS App (Future)
Planned for PR 4-6 of the iOS rollout. Will depend only on VellumAssistantShared.

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

### Adding iOS Code (Future)
1. Place in `clients/ios/vellum-assistant-ios/`
2. Import `VellumAssistantShared` for IPC, design tokens, ViewModels
3. DO NOT import `VellumAssistantLib` (macOS-only)

## Known Limitations

### iOS TCP Connection
- Currently plaintext (no TLS)
- Safe for localhost development only
- TLS layer tracked for PR 11 (Daemon authentication)

### iOS Signing Operations
- iOS clients log errors when daemon sends signing requests
- Cannot send error responses (protocol limitation)
- Daemon should detect iOS clients and avoid sending these messages

### iOS Localhost Default
- iOS defaults to `localhost:8765` in UserDefaults
- Real device usage requires configuring daemon hostname
- PR 6 (iOS settings/onboarding) will provide UI for configuration

## Documentation

- **macOS development**: See `clients/macos/CLAUDE.md`
- **PR #1821**: [iOS shared library foundation](https://github.com/vellum-ai/vellum-assistant/pull/1821)
- **iOS rollout plan**: See `.private/plans/sharded-mapping-shannon.md` (13 PRs)

## Testing

```bash
cd clients/macos
./build.sh test     # All SPM tests (both shared and macOS-specific)
```

Tests use mock implementations of protocols for dependency injection:
- `DaemonClientProtocol` → `MockDaemonClient`
- `AccessibilityTreeProviding` → `MockAccessibilityTree`
- `ScreenCaptureProviding` → `MockScreenCapture`
