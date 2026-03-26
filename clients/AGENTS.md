# Clients — Agent Guidance

## Scope and Precedence
- Applies to all client code in `clients/` (macOS, iOS, browser extensions, shared).
- Platform-specific docs (for example `clients/macos/AGENTS.md`, `clients/ios/README.md`) override or extend this file.
- `AGENTS.md` at repo root still applies; if guidance conflicts, follow the most specific document.

---

## Research Protocol (Apple Platform Work)
- Verify decisions against current Apple sources (Developer Documentation, HIG, WWDC sessions, Swift Evolution).
- Check deprecations and availability for targeted OS versions before adopting APIs.
- Prefer Apple-recommended patterns for SwiftUI, concurrency, accessibility, privacy, and app lifecycle.
- Note in the PR summary or commit message: `Apple refs checked (YYYY-MM-DD): ...`.
- If guidance is ambiguous, include a short rationale in the PR summary.

### Documentation Update Protocol
When updating any client documentation (README, AGENTS.md, ARCHITECTURE.md), contributors and agents must:
1. **Research before writing.** Cross-reference claims against current Apple documentation, recent WWDC sessions, and Swift Evolution proposals. Do not propagate outdated patterns.
2. **Verify against the codebase.** Check that documented directories, types, APIs, and patterns actually exist on disk. Run `find` or search the project before asserting a directory structure.
3. **Use evergreen language.** Avoid hardcoded counts, percentages, or version-specific claims that will drift. Prefer qualitative descriptions ("significant", "most") over brittle numbers.
4. **Cite sources for non-obvious guidance.** When a rule is based on a known Apple bug, WWDC session, or Swift Evolution proposal, include a brief citation so future readers can verify it is still current.

---

## SwiftUI and Apple Platform Practices
- Follow SwiftUI data flow and state ownership; keep state minimal and localized.
- Keep UI work on the main actor; use async/await and structured concurrency when possible.
- Avoid deprecated APIs; use availability checks for multi-platform code. See the [Deprecated API Watchlist](#deprecated-api-watchlist) below for specific APIs to avoid.
- Respect HIG defaults for layout, typography, and controls; only customize when user value is clear.
- Accessibility is required: labels for icon-only controls, Dynamic Type support, VoiceOver-friendly order.
- Localize user-facing strings; format dates/units with locale-aware formatters.
- Privacy: request the minimum permissions; never log sensitive user content.

### Deprecated API Watchlist

APIs that still compile without warning but are deprecated by Apple. Do not introduce new usages.

| Deprecated | Replacement | Since | Status | Why |
|---|---|---|---|---|
| `.foregroundColor()` | `.foregroundStyle()` | macOS 12 / iOS 15 | **Fully migrated** — do not use `.foregroundColor()` anywhere | `.foregroundStyle()` accepts any `ShapeStyle` (gradients, materials, hierarchical styles), not just `Color`. Drop-in replacement for `Color` values. |

### State Management: @Observable vs ObservableObject

For new view models and state objects targeting macOS 15+ / iOS 17+, prefer the `@Observable` macro (Observation framework) over `ObservableObject`.

<details>
<summary><strong>Migration reference table</strong></summary>

| Observation framework (preferred for new code) | Legacy ObservableObject |
|------------------------------------------------|------------------------|
| `@Observable class MyViewModel` | `class MyViewModel: ObservableObject` |
| `@State var vm = MyViewModel()` | `@StateObject var vm = MyViewModel()` |
| `@Bindable var vm` (injected reference) | `@ObservedObject var vm` |
| `@Environment(\.myService)` | `@EnvironmentObject var service` |
| Property-level tracking (only changed properties trigger re-render) | Object-level tracking (any `@Published` change re-renders all observers) |

</details>

**Why:** `@Observable` provides property-level granularity — views only re-render when the specific properties they read change, not when any property on the object changes. This eliminates the need for `objectWillChange` forwarding patterns and reduces unnecessary view updates.

**When to use `ObservableObject` vs `@Observable`:**

| Use `@Observable` (default) | Keep `ObservableObject` |
|---|---|
| New view models and state objects | Deep Combine integration (`@Published` pipelines with `sink`, `combineLatest`, `debounce`, `removeDuplicates`) |
| Classes with simple stored properties that drive UI | Classes that rely on `objectWillChange` forwarding from nested ObservableObjects |
| Leaf-node view models observed by a single view | Hub objects that subscribe to many child `objectWillChange` publishers (e.g., ConversationManager) |
| Per-entity state objects in dictionary stores | Classes conforming to protocols requiring `ObservableObject` (e.g., `SessionOverlayProviding`) |

<details>
<summary><strong>Classes migrated to @Observable</strong></summary>

The following classes have been migrated from `ObservableObject` to `@Observable`:

**macOS-only:** QuickInputTextModel, DevModeManager, RecordingHUDViewModel, NavigationHistory, AmbientAgent, DocumentManager, E2EStatusOverlayViewModel, WatchSession, SurfaceViewModel, SurfaceManager, AppListManager, TerminalSessionManager, MessageAudioPlayer, ContactsViewModel, OpenAIVoiceService, SkillsManager

**Shared (macOS + iOS):** InlineVideoEmbedStateManager, ContactsStore, MemoryItemsStore, ChannelTrustStore, ChatErrorManager, TaskProgressOverlayManager

</details>

<details>
<summary><strong>Classes intentionally remaining ObservableObject</strong></summary>

These classes stay `ObservableObject` because they have deep Combine integration, complex `objectWillChange` forwarding, or protocol requirements that make migration impractical without broader refactoring:

| Class | Rationale |
|---|---|
| `SettingsStore` | Heavy `UserDefaults.publisher` + Combine pipelines |
| `MainWindowState` | Bridges `@Observable` NavigationHistory via `withObservationTracking`; uses `objectWillChange` forwarding |
| `VoiceModeManager` | Complex Combine pipelines (audio streams, state machine transitions) |
| `ConversationManager` | Hub object subscribing to many child `objectWillChange` publishers; complex lifecycle |
| `ChatViewModel` | Extensive Combine pipelines (SSE streaming, message coalescing, debounce); bridges `@Observable` ChatErrorManager via `withObservationTracking` |
| `ChatMessageManager` | Tightly coupled to ChatViewModel's Combine publish pipeline |
| `GatewayConnectionManager` | Combine-based SSE event stream processing |
| `RecordingManager` | Audio capture Combine pipelines |
| `RecordingSourcePickerViewModel` | ScreenCaptureKit async sequences + Combine |
| `HostCuSessionProxy` | Conforms to `SessionOverlayProviding` protocol requiring `ObservableObject` |
| `ToolPermissionTesterModel` | Combine-based test execution pipeline |
| `MessageListScrollCoordinator` | Intentional `@Published` / non-reactive split for scroll performance; `isAtBottom` is deliberately non-reactive to prevent scroll-loop feedback |

</details>

#### @Observable migration patterns

**`@ObservationIgnored` for non-reactive bookkeeping.** Mark stored properties that should not trigger view updates with `@ObservationIgnored`. Use this for: Combine cancellables (`Set<AnyCancellable>`), background `Task` handles, delegate/callback closures, internal caches, and constants. Example: `@ObservationIgnored private var cancellables = Set<AnyCancellable>()`.

**`withObservationTracking` bridge for `@Observable` → `ObservableObject`.** When an `@Observable` class is owned by an `ObservableObject` parent, bridge changes using a recursive `withObservationTracking` loop that calls `objectWillChange.send()` (or a coalesced publish) on change:
```swift
private func observeChild() {
    withObservationTracking {
        _ = child.prop1
        _ = child.prop2
    } onChange: { [weak self] in
        Task { @MainActor [weak self] in
            self?.objectWillChange.send()
            self?.observeChild() // re-arm
        }
    }
}
```
See `ChatViewModel.observeErrorManager()` and `MainWindowState.observeNavigationHistory()` for production examples.

**Computed property forwarding.** When both source and target are `@Observable`, computed properties that read from an `@Observable` dependency automatically participate in observation tracking — no manual bridging needed.

**Migration:** Existing `ObservableObject` types should be migrated opportunistically. Use Combine (`@Published`, `sink`, `onReceive`) only for reactive stream processing (SSE event streams, debounce pipelines, `UserDefaults.publisher`) — not for simple state management.

**Previews:** Do not add `#Preview` or `PreviewProvider` blocks. Use the Component Gallery as the single visual review surface. If you encounter existing `#Preview` blocks, remove them.

---

## Performance and Resource Management

### View Bodies and Rendering

- **View bodies must be lightweight.** Never perform I/O, network calls, or heavy computation inside a SwiftUI view body. This includes filtering, sorting, and data transformation — do that work in the ViewModel (asynchronously), not inline during render. Cheap display-time formatting (e.g., `Date.formatted(...)`, locale-aware unit strings) is fine in the view since it must react to locale/calendar changes. Defer expensive work to `task {}`, `onAppear`, or background actors.
- **Lazy containers for large collections.** Use `LazyVStack`, `LazyHStack`, `LazyVGrid` instead of eager equivalents when the item count is unbounded or large. In particular, avoid `VStack`/`HStack` inside a `ScrollView` for large or unbounded data-driven lists — eager loading kills scroll performance. Small, fixed-size lists where visibility-sensitive logic (e.g., `onAppear` pagination triggers) matters may use eager containers intentionally.
- **Keep modifier chains lean.** Every SwiftUI modifier wraps its content in a new view value. Long chains of redundant or duplicated modifiers deepen the view tree and increase diffing cost. Group related modifiers, remove redundant ones (e.g., don't set `.font` on every row when the parent already sets it), and extract heavily-modified subtrees into standalone `@ViewBuilder` methods.
- **Scope observation narrowly.** Only observe the specific properties a view needs. Prefer granular `@Observable` properties or `withObservationTracking` over observing an entire store that publishes on unrelated changes.
<details>
<summary><strong>Per-entity observation and dictionary patterns</strong></summary>

- **Use per-entity `@Observable` objects for dictionary-stored data.** `@Observable` tracks at the property level, not per dictionary key. A `var items: [Key: Value]` property invalidates *all* readers when *any* key changes. When views display individual entries (e.g., per-subagent event lists), store each entry's data in its own `@Observable` class instance (e.g., `var states: [String: EntityState]` where `EntityState` is `@Observable`). Views that read a specific `EntityState`'s properties are only invalidated when *that* instance changes — not when a sibling entry is mutated. The dictionary itself should only be mutated when entries are added or removed (infrequent), while high-frequency updates go through the per-entity object's properties.
- **Use targeted `@Published` + `.removeDuplicates()` instead of forwarding `objectWillChange`.** Wiring one object's `objectWillChange` publisher into another's invalidates the entire SwiftUI tree on every emission. Expose a narrow `@Published var activeMessageCount: Int` (or equivalent) and attach `.removeDuplicates()` so downstream views only re-render when the value actually changes.

</details>

### High-Frequency Updates

- **Coalesce high-frequency publishes.** When a Combine publisher or `@Observable` property fires at high frequency (for example per-token streaming), coalesce updates with `throttle`, `debounce`, or a manual coalescing window to avoid render churn. Use **100 ms minimum** as the default. A **50 ms minimum** is acceptable when the body evaluation cost has been verified to be sub-millisecond (e.g. paths using the two-stage cache in `MessageListView` where only the cheap live-data stage runs per evaluation).
- **Cache expensive derived values.** Never expose a frequently-read, O(n) property as a plain computed var. Convert it to a `@Published` stored var updated on write with a `throttle` or `debounce` (same minimums as above: 100 ms default, 50 ms for verified-cheap paths). Move any heavy work (sorting, JSON sizing, filtering large collections) off the main thread before updating the stored var.
- **Scope `UserDefaults` observation with `publisher(for:)` + debounce.** Do not subscribe to `UserDefaults.didChangeNotification` (app-wide) to watch a single key — it fires on every defaults write across the whole app. Use `UserDefaults.publisher(for: \.myKey)` with a 100 ms `.debounce` to limit scope and frequency.

### Concurrency and Task Management

- **Prefer async/await and structured concurrency.** Use `Task {}` with proper cancellation over raw GCD or unstructured `Task.detached` unless there is a specific reason.
- **Always cancel subscriptions and tasks.** Store `AnyCancellable` tokens and cancel them in `deinit` or `onDisappear`. For `Task {}` started in `onAppear`, cancel in `onDisappear`. For `@StateObject` / `@ObservedObject` view models, cancel in `deinit`.
- **Remove observers and listeners.** Unsubscribe from `NotificationCenter`, KVO, and any custom event systems when the owning object is deallocated or the view disappears. Prefer the `task {}` modifier with implicit cancellation over manual `NotificationCenter.addObserver`.
<details>
<summary><strong>Task lifecycle patterns (deferred work, cancellation guards, cleanup)</strong></summary>

- **Store deferred async work as a cancellable `Task`, not `DispatchQueue.asyncAfter`.** A `DispatchQueue.asyncAfter` block cannot be cancelled. Replace it with `Task { try? await Task.sleep(...); guard !Task.isCancelled else { return }; ... }` stored in a `Task<Void, Never>?` property so it can be cancelled cleanly in `deinit` or `onDisappear`.
- **Add `guard !Task.isCancelled else { return }` after every `Task.sleep` in animation or scroll tasks.** A sleep inside a debounce task is a cancellation point; without the guard the trailing action (e.g., `proxy.scrollTo`) can fire after the task was explicitly cancelled, causing competing UI mutations.
- **Guard `defer` cleanup blocks against clobbering a newer reference.** If a task stores itself in a shared property (e.g., `scrollDebounceTask = self`), its `defer { scrollDebounceTask = nil }` must check that the property still points to *this* task before nil-ing it — otherwise it silently cancels the successor task that was assigned after the cancel.
- **Eliminate busy-wait loops with `AsyncStream`.** Replace repeated `DispatchQueue.asyncAfter` polling for state transitions (e.g., waiting for a session to reach `.active`) with an `AsyncStream` that yields on each state change. Use separate Combine subscriptions only for continuously-updating progress properties (elapsed time, counts), not for lifecycle state.
- **Atomically unsubscribe all per-resource subscriptions together.** If a manager keeps several subscription dictionaries keyed by a resource ID (e.g., per-conversation Combine cancellables, per-conversation tasks), clear all of them in a single `unsubscribeAll(for id:)` method called from one place (teardown, logout, dealloc). Piecemeal unsubscription leaves orphaned subscriptions that continue to fire after the resource is gone.
- **Replace `DispatchQueue.main.asyncAfter` with `Task.sleep` in new code.** `asyncAfter` blocks cannot be cancelled. Use `Task { try? await Task.sleep(nanoseconds: N); guard !Task.isCancelled else { return }; ... }` and store the task in a `Task<Void, Never>?` property for cancellation. In SwiftUI views, prefer `.task { }` or `.task(id:)` modifiers which auto-cancel on view removal or identity change. **Note:** `DispatchQueue.main.async { }` (no delay) is still valid for synchronous main-thread hops. **Note:** `DispatchWorkItem`-based cancelable patterns (e.g., SettingsStore verification timeouts) are a separate idiom — do not blindly convert those to `Task.sleep`.

</details>

### Memory Management

- **Avoid retain cycles.** Use `[weak self]` in closures stored by long-lived objects. Be especially careful with closures passed to Combine `sink`, `onReceive`, and completion handlers on network calls.
- **Release heavy resources promptly.** Clear large data (base64 payloads, image data, surface HTML) from memory once it is no longer displayed. Do not accumulate unbounded data across a session.
- **Hard-delete trimmed objects; don't just clear their content.** Stripping a `ChatMessage`'s text/data in-place leaves the object allocated. Use `removeSubrange` (or equivalent) so the objects are fully deallocated and ARC can reclaim the memory. Keep a `hasMoreHistory` flag set to `true` after eviction so pagination can reload the trimmed pages.
- **Register a memory pressure handler.** Long-lived managers that hold large in-memory collections should observe `DispatchSource.makeMemoryPressureSource` (or `ProcessInfo.processInfo.performExpiringActivity`) and proactively evict non-visible data before the OS kills the process. This API works on both macOS and iOS.

### Loading States

- **Use skeleton placeholders, not spinners, for complex data loads.** When loading structured or composite content — lists, cards, detail views, dashboards, multi-section screens — always use skeleton placeholders that approximate the final layout. Skeletons give users a spatial preview of what's coming, reduce perceived wait time, and eliminate layout shift when real content appears. Use `VSkeletonBone` with `.vShimmer()` for individual placeholder bones and compose them to mirror the target layout's alignment, dimensions, spacing, and shapes. See `ChatLoadingSkeleton` for the reference pattern.
- **Reserve spinners for simple, inline loading states.** `VLoadingIndicator` and `VBusyIndicator` are appropriate only for small, contained actions where the final content shape is unknown or trivial — button loading states, toolbar actions, single-value refreshes. If the loading region occupies more than ~one line of content or will render a repeating/structured layout, use a skeleton instead.
- **Match skeleton anatomy to the real content.** A skeleton should have the same number of visual "rows" or blocks, the same horizontal alignment (leading text, trailing metadata), and similar height proportions as the loaded state. Avoid generic gray rectangles that don't correspond to any real element — they look lazy and don't help the user anticipate the layout.
- **Transition gracefully from skeleton to content.** Swap skeletons for real content without jarring jumps. Prefer a short crossfade (`.transition(.opacity)` with `VAnimation.fast`) over an abrupt replacement. Never show a spinner *and* a skeleton simultaneously.

### Platform-Specific

- **Asynchronous loading.** Load data (network responses, file contents, images) asynchronously off the main thread. Show loading states while data is in flight. Never block the main thread waiting for data.
- **Image loading must be async.** Use `AsyncImage` (built-in) or a library like Kingfisher for image loading. Never decode or resize images synchronously on the main thread — this is a common source of scroll jank in image-heavy views.
- **Profile before optimizing, but follow known patterns.** Use Instruments to validate — specifically Time Profiler for main-thread spikes, Core Animation instrument for frame drops, and Allocations for memory. Launch Instruments directly from `/Applications/Instruments.app` or via `xcrun instruments`. However, the patterns above are established project standards — follow them proactively rather than waiting for a performance regression.
- **(macOS only) Background timers: gate on display state and use long polling intervals.** Set background polling intervals to at least 300 s (5 min). Before running expensive evaluation, call `CGDisplayIsAsleep(CGMainDisplayID())` and skip if the display is off. Do **not** use `NSApplication.didBecomeActiveNotification` as an activity gate for LSUIElement / accessory-mode apps — this notification never fires when the app has no dock icon, permanently disabling the feature after first use.
- **AVAudio teardown order.** Always tear down AVAudio resources in the order `removeTap` → `stop` → `reset`. Calling `stop` before `removeTap` leaves the tap dangling and causes a retain cycle that prevents `AVAudioEngine` from being deallocated.
- **Preserve sidebar↔content animation pairing in `MainWindowView`.** The sidebar and content container in `coreLayout` must both carry `.animation(VAnimation.panel, value: sidebarExpanded)` so they transition in sync when the sidebar collapses or expands. Removing the modifier from either side causes the other to snap instantly, producing a jarring layout jump. This has regressed before — when refactoring `MainWindowView` layout, verify that both the sidebar column and `chatContentView` retain their `sidebarExpanded` animation modifiers.

---

## Scroll and Layout Stability

> These rules exist because competing `proxy.scrollTo` calls have caused repeated freezes and crashes in the chat view. Follow them any time you touch scroll-position logic.

### Architecture: MessageListScrollCoordinator

All scroll state and reactions for the message list live in `MessageListScrollCoordinator` (`Features/Chat/`), split across two files with a supporting diagnostics type:

- **`MessageListScrollCoordinator.swift`** — Core state declarations (`@Published` reactive state, non-reactive bookkeeping, per-reason suppression boolean flags with begin/end helpers, follow/detach state, diagnostics forwarding, cleanup).
- **`MessageListScrollCoordinator+ScrollBehavior.swift`** — All scroll behavior: state reactions (`sendingStateChanged`, `messagesChanged`, `containerResized`, `conversationSwitched`, `anchorMessageIdChanged`), pin requests (`requestBottomPin`, `configureScrollCallbacks`), scroll restore, user scroll actions (`handleScrollUp`, `handleScrollToBottom`), suppress-auto-scroll, resize task, pagination trigger/execution.
- **`ScrollDiagnosticsRecorder.swift`** — Owns all diagnostic recording: `ChatScrollLoopGuard` (loop detection), transcript snapshot capture, and non-finite geometry logging. Extracted from the coordinator to keep it focused on scroll mechanics.

Bottom detection uses `.onScrollGeometryChange` (macOS 15+) to compute the distance from the bottom of the content. The handler computes `effectiveContentHeight - contentOffsetY - visibleRectHeight` and uses asymmetric hysteresis to set the coordinator's `isAtBottom` property: when already at bottom, `isAtBottom` stays `true` until `distanceFromBottom` exceeds 30pt (leave threshold); when not at bottom, `isAtBottom` becomes `true` only when `distanceFromBottom` is within 10pt (enter threshold). This prevents oscillation during streaming where content-height growth transiently exceeds a single threshold. This approach is reliable because it uses continuous geometry measurements rather than `ScrollPosition.viewID`, which per Apple documentation becomes `nil` on any user-initiated scroll and is therefore unsuitable for continuous bottom-detection. The reattach-on-idle logic in `onScrollPhaseChange` is the primary consumer of `isAtBottom`. The "Scroll to latest" CTA button depends solely on `isNearBottom` (the follow/detach state managed by the coordinator).

Follow/detach state for bottom-pin logic is managed directly on `MessageListScrollCoordinator` via `isFollowingBottom`, `detachFromBottom()`, and `reattachToBottom()`. When detached (user scrolled up), background pin requests are suppressed. Reattachment occurs when the user explicitly scrolls to bottom or a conversation switch resets state.

Programmatic scrolling uses `scrollPosition.scrollTo(id:anchor:)` instead of `ScrollViewReader` + `proxy.scrollTo()`. The coordinator stores a `scrollTo: (any Hashable, UnitPoint?) -> Void` closure configured during setup that captures the view-owned `scrollPosition`.

The coordinator is an `ObservableObject` owned by `MessageListView` via `@StateObject`. It separates reactive state (`@Published` properties that drive view updates) from non-reactive bookkeeping (plain stored properties that update on every scroll tick without triggering `objectWillChange`).

### Scroll Event Detection

- **User scroll detection:** Use `.onScrollPhaseChange` (macOS 15+) to detect user-initiated scroll phases (`.interacting`, `.decelerating`, `.idle`). This replaces legacy AppKit `NSEvent` scroll-wheel monitors.
- **Bottom detection:** Use `.onScrollGeometryChange(for:of:action:)` to compute `effectiveContentHeight - contentOffsetY - visibleRectHeight` and set `isAtBottom` using asymmetric hysteresis (10pt enter threshold, 30pt leave threshold) to prevent oscillation during streaming. Do not use `ScrollPosition.viewID` for bottom detection — `viewID` becomes `nil` on user-initiated scroll, making it unreliable for continuous tracking.
- **Scroll geometry tracking:** Use `.onScrollGeometryChange(for:of:action:)` (macOS 15+) to observe scroll direction, viewport height changes, and bottom detection in a single handler.

### Scroll Suppression (Per-Reason Boolean Flags)

Three plain stored boolean flags (`isResizeSuppressed`, `isPaginationSuppressed`, `isExpansionSuppressed`) manage reasons for temporarily suppressing auto-scroll-to-bottom. These are NOT `@Published` — the view never reads suppression state directly for rendering; making them `@Published` would trigger unnecessary `objectWillChange` on every suppression flip. Multiple reasons can be active concurrently; `isSuppressed` is true when any flag is set. Manage flags via per-reason helpers (`beginResizeSuppression`/`endResizeSuppression`, `beginPaginationSuppression`/`endPaginationSuppression`, `beginExpansionSuppression`/`endExpansionSuppression`). Only expansion uses a 200ms auto-timeout Task; resize and pagination manage their lifecycle manually within their task bodies. The `activeSuppressionReasons` computed property provides diagnostic strings for logs and transcript snapshots. Check `scrollCoordinator.isSuppressed` before issuing any automatic scroll-to-bottom call.

### Rules

- **Cancel auto-scroll tasks immediately on user-initiated scroll.** When the user manually scrolls (up, pagination pull, etc.), cancel the debounce/auto-scroll `Task` synchronously inside the scroll callback — before any `await`. Do not rely on the task noticing cancellation at its next sleep boundary; by then the trailing `proxy.scrollTo` may already have been scheduled, starting a fight with the user's scroll position.
- **Guard scroll `onChange` handlers with the suppression flags.** Any `onChange(of: messages.count)` that calls `proxy.scrollTo` must check `scrollCoordinator.isSuppressed`. Suppression reasons (resize, pagination, expansion) are managed via per-reason `begin`/`end` helpers on `MessageListScrollCoordinator`. Only expansion has an auto-timeout; resize and pagination are managed manually within their task bodies. This prevents auto-scroll from racing pagination scroll or other competing operations.
- **Use an in-flight guard to prevent stacking concurrent pagination loads.** The coordinator's `isPaginationInFlight` flag gates the pagination sentinel. Without it, rapid scroll-to-top can enqueue multiple concurrent loads before `isLoadingMoreMessages` is set by the async response, duplicating content and corrupting the history cursor.
- **Route all scroll reactions through coordinator methods.** Do not add inline `onChange` handlers that call `proxy.scrollTo` directly in `MessageListView`. Instead, add a new method on the coordinator (in the appropriate extension file) and call it from the view. This keeps scroll logic centralized and testable.
- **`ChatScrollLoopGuard` is diagnostic-only.** The guard monitors `scrollToRequested` (15 per 2s window) and `bodyEvaluation` (40 per 2s window) events. When thresholds are exceeded, it emits aggregate warnings via `os.Logger` and records events to `ChatDiagnosticsStore` — but it does not circuit-break or suppress scroll operations. The `scrollLoopGuardCounts` field is preserved in `ChatTranscriptSnapshot` for diagnostics.
<details>
<summary><strong>Layout timing, scroll forwarding, and .scrollPosition caveats</strong></summary>

- **Allow a layout settle delay before restoring scroll position.** After inserting new messages (pagination prepend), wait at least **32 ms** before calling `proxy.scrollTo(anchor)` so SwiftUI can finish its layout pass. If any inserted content performs an animated height change (e.g., `InlineVideoEmbedCard` at 0.25 s), increase the delay to at least the animation duration (100 ms minimum) — restoring scroll mid-animation lands at the wrong position.
- **Forward scroll/wheel events from gesture-capturing subviews.** `WKWebView` (and other `NSResponder`/`UIResponder` subclasses that capture scroll events) swallow all scroll-wheel input, preventing the enclosing `ScrollView` from scrolling. Subclass the view and override `scrollWheel(_:)` (macOS) / `gestureRecognizerShouldBegin(_:)` (iOS) to forward the event to `nextResponder` / the parent scroll view instead of consuming it.
- **`ScrollPosition` is the project standard for programmatic scroll tracking.** The message list uses `@State private var scrollPosition = ScrollPosition()` with `.scrollPosition($scrollPosition)` on the ScrollView. Programmatic scrolling uses `scrollPosition.scrollTo(id:anchor:)` via a closure on the coordinator. Do not reintroduce `ScrollViewReader` — it was removed in favor of `ScrollPosition`.
- **Add `os.Logger` diagnostics to complex scroll paths.** Pagination, suppression flag transitions, and scroll position restoration are hard to debug from a crash report alone. Log key events (`[pagination] sentinel appeared`, `[scroll] suppression on/off`, `[scroll] restoring to anchor`) via `os.Logger` with subsystem `com.vellum.vellum-assistant` so they are visible in Console.app without Xcode attached.

</details>

---

## Native SwiftUI over Custom AppKit

Prefer built-in SwiftUI primitives over custom `NSViewRepresentable` / AppKit wrappers. Custom AppKit text stacks (NSScrollView + NSClipView + NSTextView) have caused scroll-offset drift bugs that are hard to reproduce and diagnose.

<details>
<summary><strong>SwiftUI vs AppKit reference table</strong></summary>

| Need | Use this | Not this |
|------|----------|----------|
| Multi-line text input (short/medium) | `TextField(axis: .vertical)` + `.lineLimit(1...N)` | Custom `NSTextView` in `NSScrollView` |
| Multi-line text input (scrollable) | `TextField(axis: .vertical)` inside `ScrollView` with `.onGeometryChange` height measurement (see chat composer). Fall back to `GeometryReader` in `.background()` if needed | Custom AppKit `NSScrollView` + `NSClipView` + `NSTextView` stack |
| Long-form text editing | `TextEditor` (acceptable for editor-like surfaces where the user expects a full text-editing experience, e.g., contact notes, skill editing, tool permission tester). Editable code views use `HighlightedTextView` with `CodeTextView` (`NSViewRepresentable`). Read-only code views use `VCodeView` (design system), which wraps a non-editable `NSTextView` for native text selection and copy | Custom AppKit `NSScrollView` + `NSClipView` + `NSTextView` stack |
| Vertical centering in text field | Native `TextField` behavior | Custom `NSClipView` subclass |
| Auto-growing height | `ScrollView` + `.onGeometryChange` on inner content + `.frame(height: clamp(measured, min, max))`. Fall back to `GeometryReader` in `.background()` if needed | Custom AppKit height sync. Note: `.lineLimit(1...N)` truncates instead of scrolling on macOS when content exceeds N lines — only use it for short-form inputs where truncation is acceptable (e.g., `VTextEditor`) |
| Return-to-send in chat input | `.onSubmit { sendAction() }` (native SwiftUI) | `.onKeyPress(.return)` (returning `.ignored` doesn't fall back to TextField's newline behavior) |
| Newline in chat input | Shift+Return via AppKit bridge (intercepts before `.onSubmit`); treat default-mode Option+Return as send, not newline | Relying solely on `.onSubmit` modifier detection (SwiftUI's `.onSubmit` cannot distinguish Shift+Return from plain Return) |
| Keyboard shortcuts | `.onKeyPress()` modifiers | `keyDown(with:)` / `performKeyEquivalent` overrides |
| Attributed/colored text display | `AttributedString` + `Text` overlay | `layoutManager.addTemporaryAttributes` |
| File drag-drop | `.onDrop(of: [.fileURL])` | `performDragOperation` override |
| Focus management | `@FocusState` | Manual `makeFirstResponder` calls |
| Placeholder text | `TextField("placeholder", ...)` | Custom `draw()` override |

</details>

**When AppKit bridges are still needed** (keep them minimal — only AppKit-specific logic, no business logic or layout):
- Intercepting `Cmd+V` for image paste detection (pasteboard inspection not available in SwiftUI)
- Intercepting return-key shortcuts that SwiftUI cannot route precisely before `.onSubmit` fires, including `Cmd+Enter` send, `Shift+Return` newline, and default-mode `Option+Return` send
- Registering window-level event monitors (`NSEvent.addLocalMonitorForEvents`)
- Accessing `NSWindow` properties (e.g., typing redirect handlers, container view registration)

---

## File Organization and Splitting

### Extension File Naming
Use the Swift convention `TypeName+Purpose.swift` for files that contain extensions of a type. This is a long-standing Swift/Apple community convention (inherited from Objective-C categories) and is the idiomatic way to split a large type across multiple files.

**Examples:**
- `MainWindowView+Sidebar.swift` — sidebar content extension of `MainWindowView`
- `MainWindowView+Sharing.swift` — publishing and sharing logic extension
- `ChatViewModel+Streaming.swift` — streaming-related methods

### When to Split a File
- **Target: ~500-600 lines max per file.** If a file exceeds this, split it.
- **Extension files** (`TypeName+Purpose.swift`) — use when the code logically belongs to the same type but can be grouped by purpose. The extension lives in the same directory as the primary file.
- **Standalone views** (`SidebarConversationItem.swift`) — use when a view has its own identity, state, and can be reused independently. Place in a subdirectory if there are multiple related views (e.g., `Sidebar/`).
- **Helper types** (`MainWindowGroupedState.swift`) — use for supporting types (state enums, delegates) that don't belong in the main view file.

### Access Control Across File Boundaries
Swift does not allow `private` members to be accessed from a different file, even in an extension of the same type. When extracting code into a `TypeName+Purpose.swift` extension file:
- Members that were `private` must become `internal` (the default, no keyword needed).
- Only use `private` for members that are truly file-scoped. Use `internal` for members shared across extension files of the same type.
- Note this in PR descriptions when widening access — reviewers should verify no unintended callers exist.

### Comment Quality
- Comments and docstrings must describe the code's intent and behavior, not its refactoring history.
- Do not leave breadcrumb comments like `// moved to X.swift` or `// extracted from Y()`. These become stale and clutter the code.
- Good: `/// Cancellable task for the delayed hover trigger on the collapsed conversation section.`
- Bad: `// conversationItem — moved to Sidebar/SidebarConversationItem.swift (standalone view)`

---

## SwiftUI Type-Checker Complexity

Swift's type checker has quadratic complexity with chained view modifiers. Complex view bodies will cause "unable to type-check this expression in reasonable time" build errors.

**Prevention:**
- Extract groups of related views into separate `@ViewBuilder` methods (~50 lines max each).
- If you have 3+ `.onKeyPress()` handlers on a single view, extract the view + handlers into its own `@ViewBuilder`.
- Use computed properties (`private var foo: some View`) for complex sub-hierarchies.

**`.onKeyPress()` API signatures (macOS 15+):**
- `.onKeyPress(.key) { return .handled }` — no-argument closure `() -> KeyPress.Result`
- `.onKeyPress(.key, phases: .down) { press in return .handled }` — use this when you need `press.modifiers`
- These are different overloads; using the wrong signature causes confusing build errors.

---

## Common SwiftUI Pitfalls

<details>
<summary><strong>Pitfall reference table</strong></summary>

| Pitfall | Why it's bad | Do this instead |
|---------|-------------|----------------|
| `[weak context]` in NSViewRepresentable | `Context` is a struct, not a class — won't compile | Capture `context.coordinator` in a local `let` |
| `GeometryReader` as layout container | Expands to fill available space, breaking intrinsic sizing | Use `.onGeometryChange(for:body:action:)` for measurement (macOS 14+ / iOS 17+). Fall back to `GeometryReader` in `.background()` only if `.onGeometryChange` is insufficient for the use case |
| View in flexible container without size constraint | View expands to fill parent (e.g., ZStack) | Add `.fixedSize(horizontal: false, vertical: true)` to hug content |
| Mutable array in `DispatchGroup` callbacks | Race condition — callbacks may run on different threads | Wrap each append in `DispatchQueue.main.async`; for new code, prefer actor isolation or `@Sendable` closures |
| Duplicated send/action logic across code paths | Paths drift out of sync (e.g., AppKit bridge vs SwiftUI handler) | Extract shared logic into a single function both paths call |
| `.scrollPosition(id:)` with unmanaged binding | Nil binding fights SwiftUI's internal tracking, crashes on re-layout | Use `ScrollPosition()` (no idType constraint) for programmatic scrolling; use `.onScrollGeometryChange` for bottom detection |
| Strong closure capture on window | Retain cycle if window outlives view | Use `[weak coordinator]` or clear in `dismantleNSView` |
| `@Observable` dictionary as per-entity store | Any key mutation invalidates all views reading the dictionary | Use per-entity `@Observable` wrapper objects; mutate their properties instead of the dictionary |
| GeometryReader on ScrollView `.background` measuring parent frame | Measures the ScrollView's proposed size (parent frame), not content intrinsic height — creates feedback loop where state derived from the measurement drives the frame that's being measured | Place GeometryReader on the *inner content* (inside the ScrollView), and reset all derived state (`contentHeight`, `isExpanded`) atomically when content clears |
| `.foregroundColor(VColor.xxx)` | Deprecated since macOS 12 / iOS 15; fully removed from the codebase — do not reintroduce | Use `.foregroundStyle(VColor.xxx)` — drop-in replacement for `Color` values |
| Inherited `.animation()` causing layout interpolation during view switches | A parent's `.animation()` modifier applies to all descendants, including subtrees that should switch instantly (e.g., tab/panel changes) | Apply `.animation(nil, value: switchValue)` on the subtree that should not animate. This overrides the inherited animation for that specific value change while preserving sibling animations driven by other values. |
| `GeometryReader` in `.background()` for measurement | Requires a `Color.clear` wrapper, fires only via manual `.onAppear`/`.onChange`, and is easy to wire incorrectly | Use `.onGeometryChange(for:body:action:)` with the **single-value action overload** (iOS 17+ / macOS 14+). Fires on initial layout and on changes automatically — no wrapper view needed. Extract the minimal type (e.g., `Bool`, `CGFloat`) in the `body` closure so the action only fires when the derived value changes. |
| `Timer.publish` / `Timer.scheduledTimer` for UI updates | Timer continues firing when the view is off-screen, wastes energy, and requires manual lifecycle management (invalidate, cancellable storage) | Use `TimelineView(.periodic(from: .now, by: interval))` for fixed-rate progress displays or `TimelineView(.animation)` for frame-rate animations. TimelineView auto-pauses when the view is off-screen and requires no manual teardown. |

</details>

---

## Non-Apple Clients
- Follow platform-specific best practices for the target (for example, Chrome extension guidelines).
- Keep shared client logic in `clients/shared` when it is platform-agnostic.

---

## Design System (`clients/shared/DesignSystem`)

### Use Shared Components First
- Before building any new UI element, check `clients/shared/DesignSystem/` for an existing component.
- The design system is organized into layers:
  - **Tokens** — `Tokens/` contains primitive values: `ColorTokens`, `SpacingTokens`, `TypographyTokens`, `RadiusTokens`, `ShadowTokens`, `AnimationTokens`, `IconTokens` (`VIcon` enum), `IconBundle`. Always use tokens instead of raw literals.
  - **Core** — `Core/` contains foundational controls: `VButton`, `VIconButton`, `VIconView`, `VTextField`, `VTextEditor`, `VToggle`, `VSlider`, `VDropdown`, `VSearchBar`, `VBadge`, `VToast`, `VLoadingIndicator`, `VListRow`, `VDisclosureSection`, `VTab`, etc.
  - **Components** — `Components/` contains composed, higher-level components: `VCard`, `VEmptyState`, `VSplitView`, `VSidePanel`, `VTabBar`, `VSegmentedControl`, `VWaveformView`, etc.
  - **Modifiers** — `Modifiers/` contains reusable view modifiers: `CardModifier`, `PanelBackground`, `InlineWidgetCardModifier`, `NativeTooltipModifier` (`.nativeTooltip()` for system-delay tooltips, `.vTooltip()` for fast 200ms tooltips that escape clipping and never steal clicks).
  - **Gallery** — `Gallery/` is a live preview catalog of all components. Update it when adding new components.
- Use the `V`-prefixed components (for example `VButton`, `VCard`, `VTextField`) rather than rolling custom equivalents.
- Use design tokens (`VColor.*`, `VSpacing.*`, `VRadius.*`, `VFont.*`, `VShadow.*`, `VIcon.*`) instead of hardcoded values.

### Icons — Use `VIconView` and `VIcon`, Not `Image(systemName:)`

All UI icons use **vendored Lucide PDF assets** rendered through the `VIcon` enum and `VIconView`. Do not use `Image(systemName:)`, `Label(..., systemImage:)`, or `NSImage(systemSymbolName:)` for new UI work.

<details>
<summary><strong>Icon usage guide</strong></summary>

**How to use icons:**
- **Direct rendering:** `VIconView(.search, size: 14)` — drop-in replacement for `Image(systemName:)`.
- **In components that take icon strings:** Pass `VIcon.xxx.rawValue` (e.g., `VButton(label: "Save", leftIcon: VIcon.check.rawValue)`). Components use `VIcon.resolve()` internally, which handles both Lucide raw values and legacy SF Symbol names via `SFSymbolMapping`.
- **Dynamic icons from the assistant:** Use `SFSymbolMapping.icon(forSFSymbol: name, fallback: .puzzle)` at the render boundary.
- **AppKit contexts:** Use `VIcon.xxx.nsImage` or `VIcon.xxx.nsImage(size: 16)`.
- **Resolving unknown icon strings:** `VIcon.resolve("some-icon")` tries Lucide raw value first, then `SFSymbolMapping`, then falls back to `.puzzle`.

**Adding new icons:**
1. Add the Lucide icon name to `clients/shared/Resources/lucide-icon-manifest.json`
2. Add a new case to `VIcon` in `clients/shared/DesignSystem/Tokens/IconTokens.swift` with raw value `"lucide-{name}"`
3. If the icon replaces an SF Symbol, add the mapping in `clients/shared/DesignSystem/Tokens/SFSymbolMapping.swift`
4. Run `clients/scripts/sync-lucide-icons.sh` to generate the PDF asset
5. Browse available icons at [lucide.dev/icons](https://lucide.dev/icons)

**Common VIcon cases** (see `IconTokens.swift` for full list):
| Use case | VIcon |
|----------|-------|
| Close/dismiss | `.x` |
| Add/create | `.plus` |
| Search | `.search` |
| Settings/gear | `.settings` |
| Edit | `.pencil` or `.squarePen` |
| Delete | `.trash` |
| Copy | `.copy` |
| Confirm/success | `.check` or `.circleCheck` |
| Error/warning | `.triangleAlert` or `.circleAlert` |
| Info | `.info` |
| Navigation arrows | `.chevronDown`, `.chevronRight`, `.arrowUp`, etc. |
| Download/export | `.arrowDownToLine` |
| Share | `.share` |
| Pin/unpin | `.pin` / `.pinOff` |

**Exclusions** (remain on SF Symbols):
- `VAppIconGenerator`, `AppIconPickerSheet`, `AppListManager.sfSymbol` — curated SF Symbol set for deterministic icon generation
- `AppsGridView` placeholder thumbnails — renders dynamic SF Symbols from app data
- Views using `.symbolEffect(.pulse)` — SF-Symbol-specific animation (e.g., mic recording indicator, ambient scanning)

</details>

### Naming Convention: `V` Prefix
All design system types — structs, enums, and view modifiers — **must** use the `V` prefix to distinguish them from native SwiftUI types and feature-level views:
- **Views and controls:** `VButton`, `VCard`, `VTextField`, `VNavItem`, `VLoadingIndicator`
- **Tokens:** `VColor`, `VFont`, `VSpacing`, `VRadius`, `VShadow`, `VAnimation`, `VIcon`
- **View modifiers:** `.vCard()`, `.vTooltip()`, `.vShimmer()`, `.vPanelBackground()`

The `V` prefix makes design system components immediately recognizable in code, avoids naming collisions with SwiftUI built-ins (e.g., `VToggle` vs `Toggle`), and enables easy search/filtering across the codebase.

**The `V` prefix is exclusively for design system types.** Feature views (`ChatView`, `OnboardingFlowView`, `SettingsCard`), composite application views, and regular views must NOT use the `V` prefix — it would blur the boundary between design system primitives and application-level code. If a view lives in `Features/`, it does not get the prefix. If a view lives in `DesignSystem/`, it does.

### Adding New Shared Components
- If a needed component does not exist, add it to the appropriate `DesignSystem/` subdirectory (`Core/` for primitives, `Components/` for composed elements, `Modifiers/` for view modifiers).
- Follow the `V` prefix naming convention described above. Use descriptive names (for example `VProgressBar`, `VAvatar`).
- New components must be reusable and platform-agnostic; do not embed platform-specific code.
- Do not add `#Preview` / `PreviewProvider` blocks. Add or update the corresponding section in `Gallery/` so the component is represented in the catalog. See the [Preview Policy](#preview-policy--component-gallery) section below for rationale.
- If you create a component inline in a feature and it could be reused elsewhere, extract it into the design system before merging.

### Avoiding Duplication
- Do not create one-off UI elements that duplicate existing design system components. Search the `DesignSystem/` directory before building.
- When a feature needs a slight variation of an existing component, extend the component with a new parameter or style rather than forking it.

---

## Preview Policy & Component Gallery

**Rule:** Do not commit `#Preview` or `PreviewProvider` blocks. Use the Component Gallery (`clients/shared/DesignSystem/Gallery/`) as the single visual review surface for design system components.

### Why we don't use Xcode Previews

Apple's `#Preview` macro (introduced WWDC 2023, expanded in Xcode 26) is the recommended workflow for rapid SwiftUI iteration — it renders views in the Xcode canvas without building or running the full app. It is a good tool, and we are intentionally opting out of it for the following reasons:

1. **We don't develop in Xcode.** Our development workflow does not use the Xcode canvas for UI iteration. Previews are only useful inside Xcode's live canvas — they have zero value outside of it.
2. **Maintenance burden.** Preview blocks require wrapper structs for views with complex init signatures (bindings, closures, injected dependencies). These wrappers break silently when the view's API changes, creating dead code that nobody notices until someone tries to use the preview.
3. **Fragile with our architecture.** Many views depend on `DaemonClient`, `AuthManager`, or other services that require a running backend. Previews that instantiate these with `DaemonClient(config: .default)` may not render without a live daemon connection.
4. **The Component Gallery is better for our use case.** The Gallery is a live, in-app catalog that runs with real state, real theming, and real interaction — not a static Xcode canvas render. It covers all design system primitives with multiple variants and live value readouts.

### Build and performance impact of removing previews

Removing previews has minimal performance benefit — the value is **maintainability, not speed**:
- **Debug builds:** ~1-2 seconds saved on a full debug build (preview code is compiled in DEBUG only). Not meaningful.
- **Release builds / app size:** Zero impact — previews are already excluded from release builds via `#if DEBUG` or the `#Preview` macro.
- **Code health:** The real benefit. Removes dead wrapper structs that silently break when view APIs change, reduces noise for developers and agents reading the codebase, and eliminates ambiguity about whether previews are part of the team's workflow.

### What the Component Gallery covers

The Gallery (`Gallery/Sections/`) catalogs **design system components only**: inputs, buttons, toggles, sliders, layout primitives, icons, tokens, etc. It does NOT cover feature-level views (onboarding flows, chat views, settings screens). Feature views are verified by building and running the app.

### When to reconsider this policy

If the team adopts Xcode as the primary development environment and begins using the canvas for UI iteration, previews should be re-introduced. They are trivial to add per-view and provide significant value for rapid iteration (~1 second feedback vs full build-run-navigate cycles). At that point:
- Add `#Preview` blocks to feature views where quick iteration is valuable.
- Keep using the Component Gallery for design system components (it remains the better tool for cataloging).
- Wrap previews in `#if DEBUG` to exclude them from release builds.

---

## Architecture and Shared Code
- Put cross-platform logic in `clients/shared`.
- Do not introduce platform-specific dependencies into shared targets.
- Prefer dependency injection for platform services to keep logic testable.

---

## Testing and Quality
- Add or update tests when behavior changes; favor the testing patterns already used in that client.
- Keep builds and linting clean; run relevant tests when feasible.

---

## Networking: Use GatewayHTTPClient for New HTTP APIs

**Do not add new HTTP API methods to `DaemonClient` or `HTTPTransport`.** These are legacy classes being incrementally migrated to `GatewayHTTPClient`.

When adding a new HTTP endpoint call:

1. Create or extend a focused protocol (e.g. `ConversationClientProtocol`) describing the operation.
2. Implement it in a struct that calls `GatewayHTTPClient.get/post/delete(path:timeout:)`. Path encoding and `{assistantId}` substitution are handled automatically by `GatewayHTTPClient.buildRequest()` — do not percent-encode paths manually.
3. Instantiate the struct inline as a private property on the consuming type (e.g. `private let surfaceClient: any SurfaceClientProtocol = SurfaceClient()`).
4. If migrating an existing method, remove it from `DaemonClient` and `HTTPTransport` and clean up any unused `Endpoint` enum cases.

See `clients/ARCHITECTURE.md` § "GatewayHTTPClient Migration" for the full pattern and migration tracker.

---

## Docs Anti-Drift
- Avoid brittle hardcoded counts, version claims, or roadmap placeholders in client READMEs unless they are generated automatically. Prefer evergreen wording (e.g., "iOS-specific integration tests" instead of "70 iOS-specific tests").
- When updating documentation, verify claims against the current codebase rather than copying from stale sources.

---

## Maintenance

- Refresh this guidance after major Apple OS or SwiftUI releases (for example, post-WWDC).
- **When fixing a bug, consider whether the root cause represents a generalizable pitfall.** If an API was misused in a way that compiled but caused runtime crashes, freezes, or subtle misbehavior — and another developer or agent could plausibly make the same mistake — add a rule to the relevant section of this file (or the pitfalls table). This file is the team's collective memory for hard-won lessons; keeping it current prevents repeat bugs.
