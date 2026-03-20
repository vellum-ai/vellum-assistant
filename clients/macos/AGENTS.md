# macOS Client — Agent Guidance

> **Also read [`clients/AGENTS.md`](../AGENTS.md)** — it contains cross-cutting client guidance (Apple research protocol, SwiftUI practices, performance rules, state management migration path) that applies to all client code including this macOS app.

---

## What This Is

A native macOS menu bar app that controls your Mac via accessibility APIs and CGEvent input injection, powered by large language models. It lives as a sparkles icon in the menu bar — users type a task (or hold Fn for voice), and the agent executes it step-by-step.

---

## Build & Test

Single build script: `./build.sh` wraps SwiftPM → `.app` bundle → codesign. No Xcode project needed.

```bash
# Build debug .app bundle (→ dist/vellum-assistant.app)
./build.sh

# Build + launch
./build.sh run

# Build release
./build.sh release

# Run macOS-specific tests
./build.sh test

# Run a single test
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --filter SessionTests/testHappyPath_completesInThreeSteps

# Lint (strict concurrency — catches CI-only errors locally)
./build.sh lint

# Watch logs from a running instance
log stream --predicate 'subsystem == "com.vellum.vellum-assistant"' --level debug
```

---

## Architecture

### Feature Modules (`Features/`)

All UI and feature code lives in `Features/`, organized by domain:

<details>
<summary><strong>Feature module directory</strong></summary>

| Module | Purpose |
|--------|---------|
| `Ambient/` | Background screen monitoring UI |
| `Avatar/` | Avatar customization |
| `Chat/` | ChatView, ChatViewModel (multi-turn messaging), ChatMessage model |
| `CommandPalette/` | Command palette (search, actions) |
| `Contacts/` | Contact management |
| `ChannelVerification/` | Channel verification flow |
| `MainWindow/` | MainWindowView shell, ConversationSwitcherDrawer, NavigationToolbar, ConversationManager, side panels |
| `MainWindow/Panels/` | Side panels including DebugPanel (real-time trace viewer with metrics + timeline) |
| `Onboarding/` | Multi-step first-launch flow (OnboardingFlowView → OnboardingState) |
| `QuickInput/` | Quick task input popover and screen selection |
| `Session/` | Session overlay UI for computer-use task execution |
| `Settings/` | Tabbed settings panels (Appearance, Advanced, Connect, Trust, Skills, etc.) |
| `Sharing/` | Content sharing and export |
| `Surfaces/` | Daemon surface rendering (HTML/JSON overlays) |
| `Voice/` | Voice input UI (VoiceTranscriptionWindow) |

</details>

**Main window layout** (`MainWindowView`):
```
Sidebar / ConversationSwitcherDrawer  (conversation list + navigation)
NavigationToolbar                     (Chat tab + panel toggle buttons)
VSplitView                            (ChatView + optional side panel)
```

**Data flow**: `ConversationManager` (`@MainActor ObservableObject`) owns `[ConversationModel]` and a dictionary of `ChatViewModel` instances keyed by conversation ID. `MainWindowView` binds to the active `ChatViewModel` via `conversationManager.activeViewModel`. ConversationManager subscribes to each nested ChatViewModel's `objectWillChange` and forwards it via Combine so SwiftUI picks up changes.

---

### Computer Use (Proxy-Based)

Computer use runs through the daemon's main session loop. The daemon sends `host_cu_request` messages to the client, which executes them locally via `HostCuExecutor`:

1. **RECEIVE** — daemon sends a `host_cu_request` with tool name, parameters, and step number.
2. **VERIFY** — safety checks: sensitive data, destructive keys, loop detection (`ActionVerifier`).
3. **EXECUTE** — inject mouse/keyboard events via CGEvent (`ActionExecutor`). Text input uses clipboard-paste (Cmd+V) with save/restore.
4. **OBSERVE** — enumerate the AX tree (`AccessibilityTree.swift`), capture screenshot, compute `AXTreeDiff`.
5. **RESPOND** — post `host_cu_result` back to the daemon with the observation data.

`HostCuSessionProxy` provides the overlay UI state, and `HostCuExecutor` handles the execution loop. `SessionOverlayWindow` displays progress via the `SessionOverlayProviding` protocol.

### Dependency Injection

<details>
<summary><strong>Protocol-based dependency injection</strong></summary>

CU execution dependencies are protocol-based for testability:
- `AccessibilityTreeProviding` — AX enumeration (impl: `AccessibilityTreeEnumerator`)
- `ScreenCaptureProviding` — screenshots (impl: `ScreenCapture`)

</details>

### Network Layer (`Network/`)

All inference (both computer-use sessions and ambient analysis) goes through the assistant's HTTP API:
- `DaemonClient` — `@MainActor`, HTTP+SSE transport; auto-reconnect, `AsyncStream<ServerMessage>`
- `MessageTypes.swift` — Codable structs for HTTP request/response types: `host_cu_request`, `host_cu_result`, `cu_error`, `ambient_analyze`, `trace_event`, etc.
- `Network/Generated/GeneratedAPITypes.swift` — Codable Swift types used for JSON serialization. Use these generated types directly in Swift code instead of hand-writing structs.

### Ambient Agent (`Ambient/`)

A background screen-watching system that runs alongside the manual session loop:
- `AmbientAgent` — orchestrates periodic capture → OCR → analyze cycles via HTTP (configurable interval, default 30s)
- `AmbientAnalyzer.swift` — type definitions only (`AmbientDecision`, `AmbientAnalysisResult`); analysis logic lives in the daemon
- `KnowledgeStore` — persists observations as JSON in Application Support (max 500 entries)

### Voice Input

`VoiceInputManager` — hold Fn (or Ctrl, configurable) for speech-to-text via `SFSpeechRecognizer`. Shows `VoiceTranscriptionWindow` during recording.

**Keyboard shortcut detection:** Uses defense-in-depth to distinguish voice activation from keyboard shortcuts (Control+C, Fn+arrow). Timer starts on key press, but recording only begins if no other keys are pressed during the 300ms hold period. Flag check (`otherKeyPressedDuringHold`) handles cases where apps consume keyDown events (e.g., Terminal).

### App Lifecycle

The package is split into two targets for Xcode Preview support:
- **`VellumAssistantLib`** (library) — all app code, resources, and linker settings. Previews work on any SwiftUI view here.
- **`vellum-assistant`** (executable) — thin `@main` entry point in `vellum-assistant-app/` that imports `VellumAssistantLib`.

`AppDelegate` sets up: NSStatusItem with NSPopover, global hotkey (Cmd+Shift+G via Carbon `RegisterEventHotKey`), global Escape monitor, voice input, ambient agent, and onboarding flow. `VellumAssistantApp` is the `@main` entry point with `@NSApplicationDelegateAdaptor`.

### Onboarding

`Features/Onboarding/` — multi-step flow (`OnboardingFlowView` → `OnboardingState`) covering wake-up animation, naming, permissions (screen recording, microphone), Fn key setup, and an alive-check step. Shown on first launch; skip with `--skip-onboarding` in debug.

The onboarding flow includes a **managed sign-in** path: when the user clicks "Sign in", the app authenticates via WorkOS, runs `ManagedAssistantBootstrapService.ensureManagedAssistant()` to discover or create a platform-hosted assistant, persists a managed lockfile entry (`cloud: "vellum"`), and configures HTTP transport in `platformAssistantProxy` mode with session token auth. Managed mode skips local daemon hatching and actor credential bootstrap. If bootstrap fails, the user stays on the onboarding screen with a retry option. See `clients/ARCHITECTURE.md` for the full managed sign-in architecture.

---

## Design System (`DesignSystem/`)

The design system uses a two-tier architecture with functional subgrouping:

```
DesignSystem/
├── Tokens/              (VColor, VFont, VSpacing, VRadius, VShadow, VAnimation)
├── Core/                (atomic building blocks — single-responsibility controls)
│   ├── Buttons/         (VButton)
│   ├── Inputs/          (VSlider, VTextEditor, VTextField, VToggle)
│   ├── Feedback/        (VBadge, VLoadingIndicator, VShortcutTag, VToast)
│   ├── Display/         (VListRow)
│   └── Navigation/      (VTab)
├── Components/          (composed patterns — combine multiple Core elements)
│   ├── Navigation/      (VTabBar, VSegmentedControl)
│   ├── Layout/          (VAdaptiveStack, VSidePanel, VSplitView)
│   └── Display/         (VCard, VEmptyState)
├── Modifiers/           (.vCard(), .vPanelBackground(), .vTooltip())
└── Gallery/             (ComponentGalleryView — visual catalog of all tokens/components)
```

**Classification rule:**
- **Core** = atomic, single-responsibility control (wraps one native SwiftUI element or thin styling layer). Place in `Core/`.
- **Component** = composes multiple Core elements or has internal layout logic (VTabBar arranges VTabs, VCard has header/body slots, VEmptyState composes icon + title + subtitle). Place in `Components/`.
- **Feature-specific** views (e.g. SidebarConversationItem) belong in `Features/`, not in the design system.

**When to extract a design system component vs. keep it in feature code:**
- If the view is **domain-agnostic** (no references to "save", "settings", or any feature-specific concept) and **reusable across unrelated features**, it belongs in the design system. Examples: `VAdaptiveStack` (generic adaptive layout), `VCard` (generic card chrome).
- If the view carries **domain-specific semantics** (save/reset labels, hasChanges state, feature-specific props), it belongs in the feature layer — even if it composes design system components internally. Examples: `ServiceCardActions` (settings-specific button row), `PickerWithInlineSave` (settings-specific picker+save composition).
- **Test**: Can you describe the component without mentioning any feature? If yes → design system. If no → feature layer.
- Every design system component **must** have a Gallery entry in `Gallery/Sections/`. Feature components do not.

<details>
<summary><strong>Component usage guide</strong></summary>

| Need | Use this | Not this |
|------|----------|----------|
| Side-by-side content that should stack vertically at narrow widths | `VAdaptiveStack` | Raw `ViewThatFits { HStack { } VStack { } }` in feature code |
| Static horizontal layout that should never reflow | `HStack` | `VAdaptiveStack` |
| Card wrapper with consistent padding/radius | `.vCard()` modifier or `VCard` | Manual padding + background + cornerRadius |
| Button with standard styling | `VButton` with appropriate `style` and `size` | Custom `Button` with manual styling |
| Dropdown/picker input | `VDropdown` | Raw `Menu` + `Picker` |
| Text input field | `VTextField` | Raw `TextField` + manual styling |
| Secure text input | `VTextField(isSecure: true)` | Raw `SecureField` + manual styling |

</details>

All design system types use the `V` prefix (VButton, VColor, VFont, etc.). Always use design tokens instead of raw values — `VFont.body` not `Font.system(size: 13)`, `VColor.accent` not `Color.purple`.

<details>
<summary><strong>Token reference</strong></summary>

**VColor** — Adaptive semantic color tokens sourced from Figma. Each token resolves to a light/dark pair via `adaptiveColor()`:
- Surface: `surfaceBase`, `surfaceOverlay`, `surfaceActive`, `surfaceLift`
- Border: `borderDisabled`, `borderBase`, `borderHover`, `borderActive`
- Content: `contentEmphasized`, `contentDefault`, `contentSecondary`, `contentTertiary`, `contentDisabled`, `contentBackground`, `contentInset`
- Primary: `primaryDisabled`, `primaryBase`, `primaryHover`, `primaryActive`
- System: `systemPositiveStrong`/`Weak`, `systemNegativeStrong`/`Hover`/`Weak`, `systemMidStrong`/`Weak`
- Utility: `auxWhite`, `auxBlack` (non-adaptive)
- Fun: `funYellow`, `funRed`, `funPurple`, `funPink`, `funCoral`, `funTeal`, `funGreen` (non-adaptive, decorative)
- Raw palettes (Moss, Stone/Slate, Forest/Sage, Emerald, Danger, Amber) are internal — use semantic tokens above.

**VFont** — macOS HIG-aligned type scale:
- `largeTitle` (26pt semibold), `title` (22pt semibold), `headline` (13pt semibold)
- `body` (13pt), `bodyMedium` (13pt medium), `bodyBold` (13pt semibold), `bodySmall` (12pt)
- `caption` (11pt), `captionMedium` (11pt medium), `small` (10pt)
- `mono` (13pt DM Mono), `monoSmall` (11pt DM Mono), `monoBodyMedium` (13pt DM Mono medium), `monoMedium` (16pt DM Mono medium)
- `sectionTitle` (17pt medium), `sectionDescription` (13pt), `inputLabel` (12pt medium)
- `cardTitle` (16pt semibold), `cardEmoji` (32pt system)
- `display` (18pt semibold), `modalTitle` (18pt semibold), `panelTitle` (24pt medium)

**VSpacing** — 4pt grid: `xxs`(2), `xs`(4), `sm`(8), `md`(12), `lg`(16), `xl`(24), `xxl`(32), `xxxl`(48). Semantic aliases: `inline`=sm, `content`=lg, `section`=xl, `page`=xxl.

**VRadius** — `xs`(2), `sm`(4), `md`(8), `window`(10), `lg`(12), `xl`(16), `pill`(999).

**VAnimation** — `snappy` (0.12s easeOut), `fast` (0.15s easeOut), `standard` (0.25s easeInOut), `slow` (0.4s easeInOut), `spring`, `panel` (gentle spring for panels), `bouncy` (celebratory spring).

**VShadow** — `sm`, `md`, `lg`, `glow` (Amber), `accentGlow` (Violet). Applied via `.vShadow()` modifier.

</details>

---

## SwiftUI & Swift Conventions

### State Management

<details>
<summary><strong>State property wrapper guide</strong></summary>

| Pattern | When to use |
|---------|-------------|
| `@State` | Local, view-scoped transient state (hover, drag, focus, form fields) |
| `@Binding` | Pass mutable state from parent to child view |
| `@StateObject` | Own an ObservableObject for the view's lifetime (e.g. ConversationManager in MainWindowView) |
| `@ObservedObject` | Observe an ObservableObject owned elsewhere |
| `@AppStorage` | Persistent user preferences backed by UserDefaults |
| `@Observable` | Modern Observation framework (used by OnboardingState) |

</details>

### Rules

- **`@MainActor` on all ObservableObject classes** — all view models and managers that touch UI must be `@MainActor`.
- **Nested ObservableObject**: When a view reads properties from a nested ObservableObject (e.g. `conversationManager.activeViewModel.messages`), the parent must subscribe to the child's `objectWillChange` and forward it. See `ConversationManager.subscribeToActiveViewModel()`.
- **Dependency injection**: Pass dependencies (DaemonClient, AmbientAgent) through init parameters, not singletons. Session dependencies use protocols for testability.
- **Previews**: Do not add `#Preview` or `PreviewProvider` blocks. Use the Component Gallery as the single visual review surface. If you encounter existing `#Preview` blocks, remove them. See `clients/AGENTS.md` § "Preview Policy & Component Gallery" for full rationale and guidance on when to reconsider this policy.
- **Gallery**: When adding or modifying a design system primitive/component, update the corresponding Gallery section file (`Gallery/Sections/`) so the visual catalog stays current.
- **Accessibility**: Add `.accessibilityLabel()` to icon-only buttons, `.accessibilityHidden(true)` to decorative elements, and `.accessibilityValue()` to stateful controls. See existing components for patterns.

### Naming & File Placement

- Design system types: `V` prefix (VButton, VColor, VTab, etc.)
- Feature views: Place in `Features/<Module>/`. New feature modules get their own directory.
- **Extension files**: Use `TypeName+Purpose.swift` naming (e.g., `MainWindowView+Sidebar.swift`). This is the standard Swift convention for splitting a type across files. Place extension files in the same directory as the primary file.
- **Standalone child views**: Extract into their own file when the view has its own identity and state (e.g., `SidebarConversationItem.swift`). Group related views in a subdirectory (e.g., `Sidebar/`).
- **Helper/state types**: Extract into a separate file named after the type (e.g., `MainWindowGroupedState.swift` for `SharingState`, `SidebarInteractionState`, etc.).
- New `.swift` files are auto-picked up by SPM — no project file edits needed.
- Panel views: Place in `Features/MainWindow/Panels/` and add a case to `SidePanelType`.
- **File size target**: ~500-600 lines max. If a file exceeds this, split using extensions or standalone views.

---

## Key Constraints

- **Dock icon** — the app always shows a dock icon (no `LSUIElement`). The dock icon displays the assistant's avatar via `applicationIconImage`. On explicit disconnect (logout/retire/switch with no remaining assistants), `setActivationPolicy(.accessory)` hides the dock icon.
- **`Bundle.main.bundleIdentifier` is nil** in SPM builds. All `os.Logger` instances use hardcoded fallback `"com.vellum.vellum-assistant"`.
- **Adding .swift files**: Auto-picked up by SPM. No manual project file edits needed. New files go in `vellum-assistant/` (library target); only `@main` entry point lives in `vellum-assistant-app/`.
- **Popover close delay** — 300ms initial delay before session starts to let the popover close and target app regain focus.
- **SessionState enum** must stay in sync with `SessionOverlayView` pattern matching.
- **SourceKit false positives** — SourceKit may report "Cannot find X in scope" for design system types (VColor, VFont, etc.) due to SPM module resolution. These are false positives — `swift build` succeeds. Do not "fix" these by adding imports or changing code.

---

## Permissions

Requires Accessibility, Screen Recording, and Microphone permissions (System Settings > Privacy & Security). `PermissionManager` handles checking/prompting. API key stored in Keychain via `APIKeyManager`.

---

## iOS Pairing

The macOS app pairs with iOS devices via QR code with Mac-side approval. The Connect tab (Settings → Connect) is the single entry point for all pairing configuration.

- **QR Code Pairing (v4):** Settings > Connect > Show QR Code generates a v4 payload containing a one-time `pairingRequestId` and `pairingSecret` (no bearer token in the QR). The QR is pre-registered with the daemon. iOS scans the QR, sends a pairing request, and waits for Mac-side approval.
- **Approval flow:** When iOS sends a pairing request, macOS shows a floating approval prompt with Deny, Approve Once, and Always Allow options. "Always Allow" persists the device in `~/.vellum/protected/approved-devices.json` for auto-approval on future pairings.
- **LAN pairing:** Disabled by default for security. To enable, set `VELLUM_ENABLE_INSECURE_LAN_PAIRING=1`. When enabled, the QR payload includes `localLanUrl` (the gateway's LAN address). iOS tries LAN first, falls back to cloud gateway. HTTP is permitted for local/private addresses via `LocalAddressValidator.isLocalAddress()`.
- **Connect Tab Layout:** Pairing hero (QR + status) → Approved Devices list → Gateway (URL config, collapsed if set) → Advanced (bearer token, URL/token overrides) → Diagnostics (test connection) → Channels (Telegram, Voice).
- **Bearer Token:** Managed via JWT authentication. The pairing hero shows a "Generate Token" button when missing and a "Regenerate Token" link when present.

---

## Keyboard Shortcuts

When adding a new keyboard shortcut to the macOS app, you **must** also add a corresponding configurable key binding in the "Keyboard Shortcuts" section of the Settings/General page. Users should be able to customize every shortcut — do not hard-code key bindings without a matching settings entry.

---

## macOS-Specific Guidance

### AppKit + SwiftUI Interop
- Keep AppKit bridges minimal — only AppKit-specific logic (pasteboard inspection, `NSEvent` monitors, `NSWindow` access), no business logic or layout.
- Use `NSViewRepresentable` / `NSWindowRepresentable` for AppKit hosting. Capture `context.coordinator` in closures, not the `Context` struct itself (it's a value type).
- For `NSEvent.addLocalMonitorForEvents`, always remove the monitor in `deinit` or when the view disappears.

### Accessibility APIs
- All accessibility tree enumeration goes through `AccessibilityTreeProviding` protocol. Do not call AX APIs directly outside of the `AccessibilityTreeEnumerator` implementation.
- AX operations can be slow — always run enumeration off the main thread and cache results where appropriate.

### Screen Capture
- Screen capture uses `ScreenCaptureProviding` protocol for testability. The concrete `ScreenCapture` implementation uses ScreenCaptureKit.
- Always check and request Screen Recording permission before capture attempts. Handle the case where permission is denied gracefully.

### Entitlements and Sandboxing
- The app is **not sandboxed** — it requires direct access to accessibility APIs, CGEvent injection, and file system paths outside the sandbox container.
- The app binary is signed ad-hoc (or with a developer certificate); entitlements are only applied to the embedded daemon binary (`daemon-entitlements.plist`: JIT, unsigned executable memory, network client).
- Never add `com.apple.security.app-sandbox` — it would break core functionality.

### Computer-Use Safety
- All computer-use actions go through `ActionVerifier` before execution. Never bypass verification.
- Destructive key combinations (Cmd+Q, Cmd+W on sensitive apps, Ctrl+C in Terminal) are blocked by default.
- Loop detection prevents the agent from repeating the same action indefinitely.
- Clipboard save/restore wraps all paste-based text input to avoid data loss.

---

## Data Storage

- Session logs: `~/Library/Application Support/vellum-assistant/logs/session-*.json`
- Knowledge store: `~/Library/Application Support/vellum-assistant/knowledge.json`
