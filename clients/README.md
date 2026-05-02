# Clients Directory

This directory contains native client applications for the Vellum Assistant.

For client architecture details, see [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Structure

<details>
<summary><strong>Directory layout</strong></summary>

```
clients/
├── Package.swift              # macOS Swift Package Manager manifest
├── shared/                    # VellumAssistantShared - shared library code
│   ├── Network/                # Network communication (GatewayHTTPClient, EventStreamClient, MessageTypes)
│   ├── Features/Chat/         # Shared chat UI (ChatViewModel, MessageBubbleView, InputBarView, etc.)
│   ├── Features/Skills/       # SkillsStore — skills data operations
│   ├── Features/Contacts/     # ContactsStore — contacts data operations
│   ├── Features/Directory/    # DirectoryStore — apps and documents operations
│   ├── Features/ChannelTrust/ # ChannelTrustStore — guardian state and channel trust management
│   ├── Features/Memory/       # SimplifiedMemoryStore — memory observations and episodes
│   ├── Features/Settings/     # Shared settings logic
│   ├── Features/Surfaces/     # Shared surface rendering (confirmation, form)
│   ├── Features/Usage/        # UsageDashboardStore — usage data operations
│   ├── DesignSystem/          # Design tokens and components (VColor, VFont, VSpacing, etc.)
│   ├── Utilities/             # Shared utilities (APIKeyManager, FeatureFlagRegistry, etc.)
│   └── App/                   # Shared app utilities (SigningIdentityManager)
├── macos/                     # macOS-specific code
│   ├── vellum-assistant/      # VellumAssistantLib - macOS app logic
│   ├── vellum-assistant-app/  # Executable entry point
│   ├── build.sh               # Build script (wraps SPM → .app → codesign)
│   └── AGENTS.md              # Agent development guidance (macOS-specific)
└── chrome-extension/          # Chrome browser extension
```

The iOS app is a Capacitor shell that lives in
[`vellum-assistant-platform/web/ios/`](https://github.com/vellum-ai/vellum-assistant-platform);
it loads the web app over HTTPS and does not consume any Swift code from this
repo.

</details>

---

## Targets

### VellumAssistantShared (Library)
**Platforms**: macOS 15+
**Purpose**: Shared library code consumed by the macOS app

**Contains**:
- **Network layer** (`GatewayHTTPClient`, `EventStreamClient`, `MessageTypes`, `Generated/GeneratedAPITypes`) — HTTP+SSE communication with the local daemon runtime server.
  Wire types are auto-generated from the TS contract; `MessageTypes.swift` provides
  typealiases, convenience inits, the `ServerMessage` routing enum, and a few hand-maintained
  types that need Swift-specific logic (e.g. typed enums, polymorphic `AnyCodable` data).
- **Shared chat features** (`ChatViewModel`, `ChatMessage`, `MessageBubbleView`, `InputBarView`, `AttachmentStripView`, `MarkdownRenderer`, `CurrentStepIndicator`, inline widgets)
- **Design system** (`VColor`, `VFont`, `VSpacing`, `VRadius`, `VShadow`, `VAnimation`, and all `V`-prefixed components)
- **Shared feature stores** (`SkillsStore`, `ContactsStore`, `DirectoryStore`, `ChannelTrustStore` — data operations for skills, contacts, apps, documents, and guardian trust)
- **Shared utilities** (`APIKeyManager` for credential storage, `MacOSClientFeatureFlagManager`)
- **Shared app utilities** (signing identity management)

**Dependencies**: None (only system frameworks: AuthenticationServices, Network, Security)

### VellumAssistantLib (Library)
**Platforms**: macOS 15+
**Purpose**: macOS application logic

**Contains**:
- UI (AppKit views, panels, overlays)
- Computer-use features (accessibility, screen capture, input injection)
- macOS-specific integrations (menu bar, hotkeys, voice input)

**Dependencies**: VellumAssistantShared, Apple Containerization, Sentry, Sparkle
**Frameworks**: AppKit, ApplicationServices, AuthenticationServices, AVKit, CoreGraphics, Network, ScreenCaptureKit, Security, Speech, SpriteKit, Vision

### vellum-assistant (Executable)
**Platforms**: macOS 15+
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
2. Downloads and caches the Kata 3.17.0 ARM64 kernel into `clients/macos/.container-cache/` on the first app build, then bundles it into `dist/Vellum.app/Contents/Resources/DeveloperVM/`
3. Packages binary into `dist/Vellum.app` bundle
4. Codesigns with ad-hoc signature (or release identity)

---

## Development

### Adding Shared Code
1. Place library code in `clients/shared/`
2. Mark all types as `public` (cross-module access)
3. Add explicit `public init()` to all structs (memberwise inits are internal)

### Adding macOS-Only Code
1. Place in `clients/macos/vellum-assistant/`
2. Import `VellumAssistantShared` for access to network types
3. Can use AppKit, ScreenCaptureKit, etc. freely

---

## Documentation

- **macOS development**: See `clients/macos/AGENTS.md`

---

## Testing

```bash
cd clients/macos
./build.sh test     # macOS SPM tests (runs swift test --filter vellum_assistantTests)
```

Shared-package unit tests live alongside the library and run via:

```bash
cd clients
swift test --filter VellumAssistantSharedTests
```
