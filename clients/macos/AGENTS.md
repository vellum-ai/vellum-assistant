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
# Production:
log stream --predicate 'subsystem == "com.vellum.vellum-assistant"' --level debug
# Local dev:
log stream --predicate 'subsystem == "com.vellum.vellum-assistant-local"' --level debug
```

---

## Architecture

### Feature Modules (`Features/`)

All UI and feature code lives in `Features/`, organized by domain:

<details>
<summary><strong>Feature module directory</strong></summary>

| Module | Purpose |
|--------|---------|
| `AssistantSwitcher/` | Menu-bar assistant switcher with new/retire actions |
| `Avatar/` | Avatar customization |
| `ChannelVerification/` | Channel verification flow |
| `Chat/` | ChatView, ChatViewModel (multi-turn messaging), ChatMessage model |
| `CommandPalette/` | Command palette (search, actions) |
| `Contacts/` | Contact management |
| `Home/` | Home tab — relationship + capabilities surface, home feed, grouped notifications |
| `Installer/` | Native messaging host installer for Host Browser Proxy (Chrome extension CDP) |
| `MainWindow/` | MainWindowView shell, ConversationSwitcherDrawer, NavigationToolbar, ConversationManager, side panels |
| `MainWindow/Panels/` | Side panels including LogsAndUsagePanel (combined logs + usage dashboard with settings-like sidebar layout) |
| `Meet/` | In-meeting status panel |
| `Onboarding/` | Multi-step first-launch flow (OnboardingFlowView → OnboardingState) |
| `QuickInput/` | Quick task input popover and screen selection |
| `Session/` | Session overlay UI for computer-use task execution |
| `Settings/` | Tabbed settings panels (Appearance, Advanced, Connect, Trust, Skills, etc.) |
| `Sharing/` | Content sharing and export |
| `Sounds/` | SoundManager with file-based config, FSEvents watcher |
| `Surfaces/` | Daemon surface rendering (HTML/JSON overlays) |
| `Terminal/` | Native SSH terminal (developer settings, managed assistants) |
| `Voice/` | Voice input UI (VoiceTranscriptionWindow) |

(`Ambient/` is a top-level sibling of `Features/`, not inside it — see "Ambient Agent" below.)

</details>

**Main window layout** (`MainWindowView`):
```
Sidebar / ConversationSwitcherDrawer  (conversation list + navigation)
NavigationToolbar                     (Chat tab + panel toggle buttons)
VSplitView                            (ChatView + optional side panel)
```

**Data flow**: `ConversationManager` (`@MainActor ObservableObject`) owns `[ConversationModel]` and a dictionary of `ChatViewModel` instances keyed by conversation ID. `MainWindowView` binds to the active `ChatViewModel` via `conversationManager.activeViewModel`. `ChatViewModel` is `@Observable`, so SwiftUI views track property access directly at the view level without `objectWillChange` forwarding. Non-view consumers (e.g. `ConversationActivityStore`, `VoiceModeManager`) observe `@Observable` properties via `withObservationTracking` loops with generation counters for lifecycle invalidation.

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

#### `@Environment` with `@Observable` — always use optional

When reading an `@Observable` object from the environment, **always declare the property as optional** (`Type?`). Non-optional declarations crash with `Fatal error: No Observable object of type X found` if any `NSHostingController` root omits the `.environment(object)` injection — and this app has multiple independent hosting roots that don't share environments.

```swift
// ✅ Correct — safe in all hosting contexts
@Environment(AssistantFeatureFlagStore.self) private var store: AssistantFeatureFlagStore?

// ❌ Wrong — crashes if the object is missing from the environment
@Environment(AssistantFeatureFlagStore.self) private var store
```

**Ref:** [Apple Environment docs — "retrieve an optional version"](https://developer.apple.com/documentation/swiftui/environment)

### Network Layer (`Network/`)

All inference (both computer-use sessions and ambient analysis) goes through the assistant's HTTP API:
- `GatewayHTTPClient` — stateless HTTP client (enum with static async methods). Naturally `nonisolated` since it has no mutable state. See `clients/AGENTS.md` § "Networking: GatewayHTTPClient".
- `MessageTypes.swift` — Codable structs for HTTP request/response types: `host_cu_request`, `host_cu_result`, `cu_error`, `ambient_analyze`, `trace_event`, etc.
- `Network/Generated/GeneratedAPITypes.swift` — Codable Swift types used for JSON serialization. Use these generated types directly in Swift code instead of hand-writing structs.

### Ambient Agent (`Ambient/`)

A background screen-watching system that runs alongside the manual session loop:
- `AmbientAgent` — orchestrates periodic capture → OCR → analyze cycles via HTTP (configurable interval, default 30s)
- `AmbientAnalyzer.swift` — type definitions only (`AmbientDecision`, `AmbientAnalysisResult`); analysis logic lives in the daemon
- `KnowledgeStore` — persists observations as JSON in Application Support (max 500 entries)

### Voice Input

`VoiceInputManager` — hold Fn (or Ctrl, configurable) for voice input. Shows `VoiceTranscriptionWindow` during recording. Uses a **service-first STT** strategy: captured audio is encoded to WAV and sent to the assistant's configured STT service via `STTClient` (shared client in `clients/shared/Network/STTClient.swift`). Apple-native `SFSpeechRecognizer` provides real-time partial transcriptions during recording and serves as the fallback when the STT service is unconfigured or fails.

**Service-first STT precedence (dictation mode):**
1. Audio is recorded and accumulated as PCM buffers alongside a live `SFSpeechRecognizer` session for partial display.
2. On recording end, buffers are encoded to WAV via `AudioWavEncoder` and sent to the STT service through the gateway.
3. If the service returns a non-empty transcription, that text is used as the final result.
4. If the service is unconfigured (503), unavailable, or returns empty text, the native `SFSpeechRecognizer` result is used as fallback.

**Conversation mode (streaming STT):** When `VoiceInputManager.currentMode == .conversation` and `STTProviderRegistry.isStreamingAvailable` is `true` (the configured provider's `conversationStreamingMode` is `realtime-ws` or `incremental-batch`), the manager opens a real-time STT streaming session via `STTStreamingClient` in addition to the native `SFSpeechRecognizer` session. Key behaviors:

- `startStreamingSession(generation:)` creates a new `STTStreamingClient` per recording session via the injected `streamingClientFactory` closure. The generation token prevents stale-session event delivery after reconnects.
- While the streaming session is active and healthy (`streamingSessionActive && !streamingFailed`), streaming partials take priority over native `SFSpeechRecognizer` partials for UI display.
- When recording stops, if `streamingReceivedFinal && !streamingFailed`, the accumulated `streamingFinalText` is used directly. Otherwise, the batch STT resolution path (`STTClient.transcribe()`) provides the fallback.
- On streaming failure (`STTStreamFailure` — connection error, timeout, rejected, abnormal closure), `streamingFailed` is set to `true` and the batch path handles completion on stop.
- `tearDownStreamingSession()` signals graceful stop (`client.stop()`) before forcible close (`client.close()`). All streaming state (`streamingClient`, `streamingSessionActive`, `streamingFinalText`, `streamingReceivedFinal`, `streamingFailed`) is reset.

**Voice mode (streaming):** `OpenAIVoiceService` follows the same service-first pattern for turn-final transcript resolution. Per-turn PCM audio is encoded to WAV and sent to the STT service. The service result takes precedence; the live `SFSpeechRecognizer` transcript is used as fallback.

**STT adapter:** The `SpeechRecognizerAdapter` protocol (`Features/Voice/SpeechRecognizerAdapter.swift`) abstracts `SFSpeechRecognizer` static APIs and instance creation for partial transcription and fallback. The production implementation is `AppleSpeechRecognizerAdapter`. Both `VoiceInputManager` and `OpenAIVoiceService` accept the adapter, `STTClient`, and `streamingClientFactory` via init injection, enabling tests to substitute mocks without hardware or permission dependencies.

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
├── Tokens/              (VColor, VFont, VSpacing, VRadius, VShadow, VAnimation, VIcon, VSizing, VMeadow, + web token export)
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
- Fun: `funYellow`, `funRed`, `funPurple`, `funPink`, `funCoral`, `funTeal`, `funGreen`, `funBlue` (non-adaptive, decorative)
- Raw palettes (Moss, Stone/Slate, Forest/Sage, Emerald, Danger, Amber) are internal — use semantic tokens above.

**VFont** — Figma-sourced type scale. Sizes use `adaptiveSize()` (slightly smaller on iOS):
- Brand (Instrument Serif): `brandMedium` (32pt), `brandSmall` (22pt), `brandMini` (16pt)
- Display (DM Sans): `displayLarge` (32pt 400)
- Title (DM Sans): `titleLarge` (24pt 400), `titleMedium` (20pt 400), `titleSmall` (16pt 500)
- Body Large (DM Sans, 16pt): `bodyLargeLighter` (300), `bodyLargeDefault` (400), `bodyLargeEmphasised` (500)
- Body Medium (DM Sans, 14pt): `bodyMediumLighter` (300), `bodyMediumDefault` (400), `bodyMediumEmphasised` (500)
- Body Small (DM Sans, 12pt): `bodySmallDefault` (400), `bodySmallEmphasised` (500)
- Label (DM Sans): `labelDefault` (11pt 400), `labelSmall` (10pt 400)
- Numeric: `numericMono` (11pt DM Sans tabular)
- Specialty: `menuCompact` (13pt 400), `chat` (16pt 400)
- Emoji: `cardEmoji` (32pt system), `onboardingEmoji` (80pt adaptive system)
- NSFont bridge (AppKit interop, used by `NSTextView` bridges): `nsChat`, `nsBodyMediumDefault`, `nsBodyMediumLighter`, `nsBodySmallDefault`, `nsMono`, `nsMonoBold`, `nsMonoItalic`

DM Mono is not used in the SwiftUI-facing palette anymore (removed when the type scale was realigned to Figma). Tabular numerics use `numericMono` (DM Sans tabular).

**VSpacing** — 4pt grid: `xxs`(2), `xs`(4), `sm`(8), `md`(12), `lg`(16), `xl`(24), `xxl`(32), `xxxl`(48). Semantic aliases: `inline`=sm, `content`=lg, `section`=xl, `page`=xxl.

**VRadius** — `xs`(2), `sm`(4), `chip`(6), `md`(8), `window`(10), `lg`(12), `xl`(16), `xxl`(20), `pill`(999).

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
| `@State` | Local, view-scoped transient state (hover, drag, focus, form fields). Also owns `@Observable` objects for the view's lifetime. |
| `@Binding` | Pass mutable state from parent to child view |
| `@Bindable` | Derive bindings from an `@Observable` object injected from a parent |
| `@StateObject` | Own an `ObservableObject` for the view's lifetime (e.g. ConversationManager in MainWindowView) |
| `@ObservedObject` | Observe an `ObservableObject` owned elsewhere |
| `@AppStorage` | Persistent user preferences backed by UserDefaults |
| `@Observable` | Macro for model/VM classes — most view models and managers use this. See `clients/AGENTS.md` § "State Management" for the full decision guide, migrated class list, and migration patterns. |

</details>

### Rules

- **`@MainActor` on stateful types (view models, managers, clients with mutable state)** — see `clients/AGENTS.md` § "@MainActor Isolation Boundaries" for the full rule, reference links, and examples.
- **Nested ObservableObject**: When a view reads properties from a nested ObservableObject (e.g. `conversationManager.activeViewModel.messages`), the parent must subscribe to the child's `objectWillChange` and forward it. See `ConversationManager.subscribeToActiveViewModel()`.
- **`@Observable` → `ObservableObject` bridge**: When an `@Observable` child is owned by an `ObservableObject` parent, use a recursive `withObservationTracking` loop to forward changes. Prefer migrating the parent to `@Observable` so nested tracking works automatically — see `clients/AGENTS.md` for the migration pattern.
- **Dependency injection**: Pass dependencies through init parameters, not singletons. Session dependencies use protocols for testability.
- **Previews**: Do not add `#Preview` or `PreviewProvider` blocks. Use the Component Gallery as the single visual review surface. If you encounter existing `#Preview` blocks, remove them. See `clients/AGENTS.md` § "Preview Policy & Component Gallery" for full rationale and guidance on when to reconsider this policy.
- **Flatten modifier chains**: Never stack consecutive `.padding()` modifiers or duplicate `.background()` calls. Merge them into a single modifier to reduce `UnaryLayoutEngine` wrapper depth. Each modifier creates a layout engine wrapper that SwiftUI traverses recursively during alignment resolution — deep chains cause measurable layout stalls in `LazyVStack` / `LazyHStack` (see [WWDC23: Demystify SwiftUI performance](https://developer.apple.com/videos/play/wwdc2023/10160/)).
  - **Padding**: Use `.padding(EdgeInsets(top:leading:bottom:trailing:))` instead of separate `.padding(.horizontal, x).padding(.vertical, y)` or `.padding(.leading, a).padding(.trailing, b).padding(.vertical, c)`.
  - **Background**: Use a single `.background { }` with a `ZStack` inside instead of chaining multiple `.background()` calls.
  - **No-op backgrounds**: Never add invisible backgrounds like `.background(Capsule().fill(Color.clear))` — they create layout wrappers with zero visual effect.
- **No animated insertions in chat `LazyVStack`**: ANY animated insertion/removal in a `LazyVStack` triggers `motionVectors` — an O(n) `sizeThatFits` measurement over ALL children that defeats lazy loading and causes multi-minute hangs. The chat message list uses `.transaction { $0.animation = nil }` to suppress all insertion animations. Do NOT remove that modifier or wrap content mutations in `withAnimation` that flows into the `LazyVStack`. See [`.transaction` docs](https://developer.apple.com/documentation/swiftui/view/transaction(_:)) and [WWDC23: Demystify SwiftUI performance](https://developer.apple.com/videos/play/wwdc2023/10160/).
- **Geometry observations must not drive state that changes the observed layout**: if a subtree is size-constrained (e.g., `.frame(height:)`, `.clipped()`) and an `onGeometryChange` or `GeometryReader` inside it writes the measured height/width into `@State` that gates the same constraint, you get a feedback loop — the observed value is the *clamped* value, so the decision to clamp flips off, the frame is removed, the child re-measures larger, the decision flips back on, and the layout oscillates or settles incorrectly. Derive layout-gating decisions from the model (content counts, text length, attachment types) or from a container-level geometry source that is *not* inside the constrained subtree. See [`onGeometryChange` docs](https://developer.apple.com/documentation/swiftui/view/ongeometrychange(for:of:action:)).
- **No `.frame(maxWidth:)`, `.frame(maxHeight:)`, or `.frame(maxWidth:maxHeight:alignment:)` inside LazyVStack/LazyHStack/LazyVGrid cell hierarchy**: These create [`_FlexFrameLayout`](https://developer.apple.com/documentation/swiftui/view/frame(minwidth:idealwidth:maxwidth:minheight:idealheight:maxheight:alignment:)) whose `placement()` queries each child's explicit alignment via [`ViewDimensions.subscript`](https://developer.apple.com/documentation/swiftui/viewdimensions). Nested FlexFrames recurse O(depth × children) per layout pass. **This applies to ALL `maxWidth`/`maxHeight` values, not just `.infinity`** — bounded values like `.frame(maxWidth: 360)` still create `_FlexFrameLayout` and trigger the alignment cascade. The difference is magnitude, not kind. See [WWDC23: Demystify SwiftUI performance](https://developer.apple.com/videos/play/wwdc2023/10160/). Safe alternatives:
  - **`.widthCap(N)`** — uses `WidthCapLayout` ([Layout protocol](https://developer.apple.com/documentation/swiftui/layout), O(1)), caps width without creating `_FlexFrameLayout`. See `WidthCapLayout.swift`. Used in 10+ places in the codebase (PRs #24589, #26007, #26092).
  - **`.fixedWidth(N)`** — uses `FixedWidthLayout` ([Layout protocol](https://developer.apple.com/documentation/swiftui/layout), O(1)), sets a definite width without creating `_FrameLayout`. See `FixedWidthLayout.swift`.
  - `.frame(width: exactWidth)` — [`_FrameLayout`](https://developer.apple.com/documentation/swiftui/view/frame(width:height:alignment:)), safe for `sizeThatFits` (O(1)), but `placeSubviews` still queries child alignment via `commonPlacement → ViewDimensions[guide]`. **Not safe as a cascade barrier** — use `.fixedWidth()` instead when the child subtree contains a `LazyVStack` or deep view hierarchy.
  - `HStack { content; Spacer(minLength: 0) }` — leading alignment without queries.
  - `HStack { Spacer(minLength: 0); content }` — trailing alignment without queries.
  - [`.containerRelativeFrame(.horizontal)`](https://developer.apple.com/documentation/swiftui/view/containerrelativeframe(_:alignment:)) — width constraint without FlexFrame.
  
  Never trade `HStack+Spacer` for `.frame(alignment:)` in lazy containers — fewer layout nodes is not worth O(n) recursive alignment queries per node.
  
  **Enforced mechanically in CI**: [`clients/scripts/check-flexframe.sh`](../scripts/check-flexframe.sh) fails the build on new `.frame(maxWidth:)` / `.frame(maxHeight:)` inside `Features/Chat/`, `Features/Home/`, and `Features/MainWindow/`. Known intentional leaves are listed in [`clients/scripts/flexframe-allowlist.txt`](../scripts/flexframe-allowlist.txt) with rationale. The manual audit process missed regressions twice (#25947 wrong call on bounded `maxWidth`, #26220 deferred leaves) before the lint existed — prefer fixing the code over adding allowlist entries; the allowlist is a last resort.
  
  **Leaf wrapper exception (O(0) cascade)**: `_FlexFrameLayout` wrapping a view with no descendants — `Text`, `Image`, `VIconView`, `RoundedRectangle`, etc. — has nothing to cascade into. The alignment query bottoms out immediately. Documented allowlist case: [`QueuedMessageRow.swift:55`](vellum-assistant/Features/Chat/QueuedMessageRow.swift) `.frame(maxWidth: .infinity, alignment: .leading)` around a leaf `Text` with `.lineLimit(1).truncationMode(.tail)` — a configuration `HStack + Spacer` breaks cleanly (truncation stops working because the Text takes intrinsic width first). If you must wrap a leaf, prefer `HStack + Spacer` or `.widthCap` anyway; use the allowlist only when those break required semantics.
  
  **Non-lazy cascades**: the same `explicitAlignment` recursion applies **anywhere** `_FlexFrameLayout` modifiers are nested inside an animated subtree — not only under `.fixedSize()` or intrinsic-sizing parents. `MoveTransition` (`.transition(.move(…))`) forces uncached full layout on every animation frame, turning a normally-amortised cascade into a stack overflow when FlexFrame nesting depth reaches ~6-7 levels. The fix is the same: replace `_FlexFrameLayout` with safe alternatives (`HStack + Spacer`, `.layoutPriority(1)`, `.containerRelativeFrame`, `.fixedWidth()`). Switching to `.transition(.opacity)` is a workaround, not a fix — it masks the latent cascade. See [`Layout.explicitAlignment`](https://developer.apple.com/documentation/swiftui/layout/explicitalignment(of:in:proposal:subviews:cache:)-8cl0p) and [WWDC23: Demystify SwiftUI performance](https://developer.apple.com/videos/play/wwdc2023/10160/).
- **No `.frame(maxHeight:)` on ScrollView inside LazyVStack cells**: `.frame(maxHeight:)` creates `_FlexFrameLayout` which measures the ScrollView's full content height before clamping — defeating lazy loading. Use the two-path pattern instead: long content gets `ScrollView { }.frame(height: fixedHeight)` (definite height, O(1)); short content renders directly with no ScrollView. See [`.frame(width:height:alignment:)`](https://developer.apple.com/documentation/swiftui/view/frame(width:height:alignment:)) vs [`.frame(minWidth:...maxHeight:...)`](https://developer.apple.com/documentation/swiftui/view/frame(minwidth:idealwidth:maxwidth:minheight:idealheight:maxheight:alignment:)).
- **Use `.fixedWidth()` (not `.frame(width:)` or `.frame(maxWidth:)`) on ScrollView content with LazyVStack**: `.frame(width:)` creates [`_FrameLayout`](https://developer.apple.com/documentation/swiftui/view/frame(width:height:alignment:)) whose `sizeThatFits` returns O(1), but whose `placeSubviews` calls `commonPlacement → ViewDimensions[guide]` — querying child alignment and cascading O(n × depth) through the `LazyVStack` subtree. `.fixedWidth()` uses `FixedWidthLayout` ([Layout protocol](https://developer.apple.com/documentation/swiftui/layout)) which returns `nil` from [`explicitAlignment`](https://developer.apple.com/documentation/swiftui/layout/explicitalignment(of:in:proposal:subviews:cache:)-8ofeu) and places children at the origin with `.topLeading` anchor — no alignment query. Do NOT use a custom `Layout` container **between the outer modifier chain and the `ScrollView`** — custom `Layout` containers at that level disrupt SwiftUI's internal scroll infrastructure. `FixedWidthLayout` / `.fixedWidth()` used *inside* the ScrollView content is safe.
- **Chat-cell widths read from `@Environment(\.bubbleMaxWidth)`, not `VSpacing.chatBubbleMaxWidth` directly**: `MessageListContentView` sets the env to a container-aware value (`min(chatBubbleMaxWidth, chatColumnWidth - 2*xl)`); views inside the chat subtree (images, markdown content, inline previews, thinking blocks) must read it so they shrink with the window. The `VSpacing` token is only the static fallback for first-layout pass (env reports 0 until `GeometryReader` resolves) or non-chat contexts. `MarkdownSegmentView.maxContentWidth` in particular is applied as a definite `.frame(width:)` — callers passing a larger value than the actual container cause visible overflow.
- **Gallery**: When adding or modifying a design system primitive/component, update the corresponding Gallery section file (`Gallery/Sections/`) so the visual catalog stays current.
- **Accessibility**: See `clients/AGENTS.md` § [Accessibility](../AGENTS.md#accessibility) for the full checklist (labels, hidden elements, custom interactions, AppKit panels). All rules there apply to macOS components.

### Naming & File Placement

- Design system types: `V` prefix (VButton, VColor, VTab, etc.). The `V` prefix is exclusively for design system types — feature views, composite application views, and regular views must NOT use it.
- Feature views: Place in `Features/<Module>/` without the `V` prefix. New feature modules get their own directory.
- **Extension files**: Use `TypeName+Purpose.swift` naming (e.g., `MainWindowView+Sidebar.swift`). This is the standard Swift convention for splitting a type across files. Place extension files in the same directory as the primary file.
- **Standalone child views**: Extract into their own file when the view has its own identity and state (e.g., `SidebarConversationItem.swift`). Group related views in a subdirectory (e.g., `Sidebar/`).
- **Helper/state types**: Extract into a separate file named after the type (e.g., `MainWindowGroupedState.swift` for `SharingState`, `SidebarInteractionState`, etc.).
- New `.swift` files are auto-picked up by SPM — no project file edits needed.
- Panel views: Place in `Features/MainWindow/Panels/` and add a case to `SidePanelType`.
- **File size target**: ~500-600 lines max. If a file exceeds this, split using extensions or standalone views.
- **Build-script-only inputs stay out of the SPM target.** Files consumed by `build.sh`/`actool` (Icon Composer `.icon` bundles, per-environment icon sources, etc.) but not loaded at runtime via `Bundle.module`/`Bundle.main` belong in `clients/macos/build-resources/`, not under the SPM target's `Resources/`. Putting them inside the target forces a choice between wrongly bundling them into the library resource bundle (`.process`/`.copy`) or masking the layout with `.exclude`. See [Apple — Bundling resources with a Swift package](https://developer.apple.com/documentation/xcode/bundling-resources-with-a-swift-package).

---

## Key Constraints

- **Dock icon** — the app always shows a dock icon (no `LSUIElement`). The dock icon displays the assistant's avatar via `applicationIconImage`. On explicit disconnect (logout/retire/switch with no remaining assistants), `setActivationPolicy(.accessory)` hides the dock icon.
- **`Bundle.main.bundleIdentifier` is nil** in SPM builds. Use `Bundle.appBundleIdentifier` (defined in `clients/shared/Utilities/AppBundleIdentifier.swift`) for all logger subsystems and self-detection checks — it resolves `Bundle.main.bundleIdentifier` with a fallback to `"com.vellum.vellum-assistant"`. Never hardcode the bundle identifier string directly.
- **Adding .swift files**: Auto-picked up by SPM. No manual project file edits needed. New files go in `vellum-assistant/` (library target); only `@main` entry point lives in `vellum-assistant-app/`.
- **Popover close delay** — 300ms initial delay before session starts to let the popover close and target app regain focus.
- **SessionState enum** must stay in sync with `SessionOverlayView` pattern matching.
- **SourceKit false positives** — SourceKit may report "Cannot find X in scope" or "No such module" for design system types (VColor, VFont, etc.) or shared modules (VellumAssistantShared) due to SPM module resolution. These are false positives — `swift build` succeeds. Do not "fix" these by adding imports or changing code.
- **Stale SPM module cache after worktree switches** — when switching between `/do` worktrees (or otherwise moving between cloned copies), SPM's `clients/.build/arm64-apple-macosx/debug/ModuleCache/` holds `.pcm` files compiled with absolute paths to directories that no longer exist. Symptoms: both SourceKit and `swift build` report errors like "Type `Bundle` has no member `appBundleIdentifier`" or "No such module `VellumAssistantShared`" on files that were clean in the other worktree. Error output contains a telltale `was compiled with module cache path '…-wt-do-…'` line pointing at the deleted worktree. Fix: `rm -rf clients/.build/arm64-apple-macosx/debug/ModuleCache` and rebuild. Do NOT start adding imports.

---

## Permissions

Requires Accessibility, Screen Recording, and Microphone permissions (System Settings > Privacy & Security). `PermissionManager` handles checking/prompting. API key stored via `APIKeyManager`.

---

## iOS Pairing

The macOS app pairs with iOS devices via QR code with Mac-side approval. The Connect tab (Settings → Connect) is the single entry point for all pairing configuration.

- **QR Code Pairing (v4):** Settings > Connect > Show QR Code generates a v4 payload containing a one-time `pairingRequestId` and `pairingSecret` (no bearer token in the QR). The QR is pre-registered with the daemon. iOS scans the QR, sends a pairing request, and waits for Mac-side approval.
- **Approval flow:** When iOS sends a pairing request, macOS shows a floating approval prompt with Deny, Approve Once, and Always Allow options. "Always Allow" persists the device in `~/.vellum/protected/approved-devices.json` for auto-approval on future pairings.
- **LAN pairing:** Disabled by default for security. To enable, set `VELLUM_ENABLE_INSECURE_LAN_PAIRING=1`. When enabled, the QR payload includes `localLanUrl` (the gateway's LAN address). iOS tries LAN first, falls back to cloud gateway. HTTP is permitted for local/private addresses via `LocalAddressValidator.isLocalAddress()`.
- **Connect Tab Layout:** Pairing hero (QR + status) → Approved Devices list → Gateway (URL config, collapsed if set) → Advanced (bearer token, URL/token overrides) → Diagnostics (test connection) → Channels (Telegram, Voice).
- **Bearer Token:** Managed via JWT authentication. The pairing hero shows a "Generate Token" button when missing and a "Regenerate Token" link when present.

---
## Build Flags

- `clients/macos/build.sh` bundles the Kata 3.17.0 ARM64 kernel into `Vellum.app/Contents/Resources/DeveloperVM/` and caches the downloaded archive under `clients/macos/.container-cache/`.

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
- **Never call `AXUIElement*` APIs from `@MainActor`** — they are synchronous cross-process IPC and will stall the caller. Wrap in `Task.detached` and expose via `async`. See [`AXUIElement.h`](https://developer.apple.com/documentation/applicationservices/axuielement_h).
- Always set [`AXUIElementSetMessagingTimeout`](https://developer.apple.com/documentation/applicationservices/1462085-axuielementsetmessagingtimeout) on the app element before querying.

### Screen Capture
- Screen capture uses `ScreenCaptureProviding` protocol for testability. The concrete `ScreenCapture` implementation uses ScreenCaptureKit.
- Always check and request Screen Recording permission before capture attempts. Handle the case where permission is denied gracefully.

### Entitlements and Sandboxing
- The app is **not sandboxed** — it requires direct access to accessibility APIs, CGEvent injection, and file system paths outside the sandbox container.
- The main app binary is signed with `app-entitlements.plist` ([`com.apple.security.device.audio-input`](https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.security.device.audio-input) — required for microphone access under [Hardened Runtime](https://developer.apple.com/documentation/xcode/configuring-the-hardened-runtime)).
- The embedded daemon binary is signed with `daemon-entitlements.plist` (JIT, unsigned executable memory, network client).
- If new hardware access is needed (e.g., camera), add the corresponding hardened runtime entitlement to `app-entitlements.plist`.
- Never add `com.apple.security.app-sandbox` — it would break core functionality.

### Computer-Use Safety
- All computer-use actions go through `ActionVerifier` before execution. Never bypass verification.
- Destructive key combinations (Cmd+Q, Cmd+W on sensitive apps, Ctrl+C in Terminal) are blocked by default.
- Loop detection prevents the agent from repeating the same action indefinitely.
- Clipboard save/restore wraps all paste-based text input to avoid data loss.

### External URLs

All `vellum.ai` and external links the app navigates to (docs pages, terms of service, help menu items, etc.) live in `vellum-assistant/App/AppURLs.swift` as `public static` accessors. Do not hardcode `URL(string: "https://...")!` at call sites — add a new accessor to `AppURLs` and reference it.

- All `AppURLs` members are `public` so the `vellum-assistant-app` shell target can use them via `import VellumAssistantLib`.
- The docs base URL honors a `VELLUM_DOCS_BASE_URL` env var (validated as an absolute http(s) URL with no query/fragment, falls back to `https://www.vellum.ai/docs` on failure).
- If you introduce a new env-var-overridable URL, also: (1) embed the var into `Info.plist`'s `LSEnvironment` in `clients/macos/build.sh` — LaunchServices doesn't inherit shell env, so `./build.sh run` requires the embedding (XML-escape values; see the existing `VELLUM_DOCS_BASE_URL` block for the pattern); (2) register the var in `assistant/src/tools/terminal/safe-env.ts` and `assistant/src/config/env-registry.ts` per `assistant/CLAUDE.md` § "Adding new environment variables".

---

## Data Storage

- Session logs: `~/Library/Application Support/vellum-assistant/logs/session-*.json`
- Knowledge store: `~/Library/Application Support/vellum-assistant/knowledge.json`
