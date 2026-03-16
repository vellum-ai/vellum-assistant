# Clients — Agent Guidance

## Scope and Precedence
- Applies to all client code in `clients/` (macOS, iOS, iPadOS, watchOS, tvOS, browser extensions, shared).
- Platform-specific docs (for example `clients/macos/CLAUDE.md`, `clients/ios/README.md`) override or extend this file.
- `AGENTS.md` at repo root still applies; if guidance conflicts, follow the most specific document.

---

## Research Protocol (Apple Platform Work)
- Verify decisions against current Apple sources (Developer Documentation, HIG, WWDC sessions, Swift Evolution).
- Check deprecations and availability for targeted OS versions before adopting APIs.
- Prefer Apple-recommended patterns for SwiftUI, concurrency, accessibility, privacy, and app lifecycle.
- Note in the PR summary or commit message: `Apple refs checked (YYYY-MM-DD): ...`.
- If guidance is ambiguous, include a short rationale in the PR summary.

---

## SwiftUI and Apple Platform Practices
- Follow SwiftUI data flow and state ownership; keep state minimal and localized.
- Keep UI work on the main actor; use async/await and structured concurrency when possible.
- Avoid deprecated APIs; use availability checks for multi-platform code.
- Respect HIG defaults for layout, typography, and controls; only customize when user value is clear.
- Accessibility is required: labels for icon-only controls, Dynamic Type support, VoiceOver-friendly order.
- Localize user-facing strings; format dates/units with locale-aware formatters.
- Privacy: request the minimum permissions; never log sensitive user content.

---

## Performance and Resource Management

### View Bodies and Rendering

- **View bodies must be lightweight.** Never perform I/O, network calls, or heavy computation inside a SwiftUI view body. Defer work to `task {}`, `onAppear`, or background actors.
- **Lazy containers for large collections.** Use `LazyVStack`, `LazyHStack`, `LazyVGrid` instead of eager equivalents when the item count is unbounded or large.
- **Scope observation narrowly.** Only observe the specific properties a view needs. Prefer granular `@Observable` properties or `withObservationTracking` over observing an entire store that publishes on unrelated changes.
- **Use per-entity `@Observable` objects for dictionary-stored data.** `@Observable` tracks at the property level, not per dictionary key. A `var items: [Key: Value]` property invalidates *all* readers when *any* key changes. When views display individual entries (e.g., per-subagent event lists), store each entry's data in its own `@Observable` class instance (e.g., `var states: [String: EntityState]` where `EntityState` is `@Observable`). Views that read a specific `EntityState`'s properties are only invalidated when *that* instance changes — not when a sibling entry is mutated. The dictionary itself should only be mutated when entries are added or removed (infrequent), while high-frequency updates go through the per-entity object's properties.
- **Use targeted `@Published` + `.removeDuplicates()` instead of forwarding `objectWillChange`.** Wiring one object's `objectWillChange` publisher into another's invalidates the entire SwiftUI tree on every emission. Expose a narrow `@Published var activeMessageCount: Int` (or equivalent) and attach `.removeDuplicates()` so downstream views only re-render when the value actually changes.

### High-Frequency Updates

- **Coalesce high-frequency publishes.** When a Combine publisher or `@Observable` property fires at high frequency (for example per-token streaming), coalesce updates with `throttle`, `debounce`, or a manual coalescing window (100 ms minimum) to avoid render churn.
- **Cache expensive derived values.** Never expose a frequently-read, O(n) property as a plain computed var. Convert it to a `@Published` stored var updated on write with a minimum 100 ms `throttle` or `debounce`. Move any heavy work (sorting, JSON sizing, filtering large collections) off the main thread before updating the stored var.
- **Scope `UserDefaults` observation with `publisher(for:)` + debounce.** Do not subscribe to `UserDefaults.didChangeNotification` (app-wide) to watch a single key — it fires on every defaults write across the whole app. Use `UserDefaults.publisher(for: \.myKey)` with a 100 ms `.debounce` to limit scope and frequency.

### Concurrency and Task Management

- **Prefer async/await and structured concurrency.** Use `Task {}` with proper cancellation over raw GCD or unstructured `Task.detached` unless there is a specific reason.
- **Always cancel subscriptions and tasks.** Store `AnyCancellable` tokens and cancel them in `deinit` or `onDisappear`. For `Task {}` started in `onAppear`, cancel in `onDisappear`. For `@StateObject` / `@ObservedObject` view models, cancel in `deinit`.
- **Remove observers and listeners.** Unsubscribe from `NotificationCenter`, KVO, and any custom event systems when the owning object is deallocated or the view disappears. Prefer the `task {}` modifier with implicit cancellation over manual `NotificationCenter.addObserver`.
- **Store deferred async work as a cancellable `Task`, not `DispatchQueue.asyncAfter`.** A `DispatchQueue.asyncAfter` block cannot be cancelled. Replace it with `Task { try? await Task.sleep(...); guard !Task.isCancelled else { return }; ... }` stored in a `Task<Void, Never>?` property so it can be cancelled cleanly in `deinit` or `onDisappear`.
- **Add `guard !Task.isCancelled else { return }` after every `Task.sleep` in animation or scroll tasks.** A sleep inside a debounce task is a cancellation point; without the guard the trailing action (e.g., `proxy.scrollTo`) can fire after the task was explicitly cancelled, causing competing UI mutations.
- **Guard `defer` cleanup blocks against clobbering a newer reference.** If a task stores itself in a shared property (e.g., `scrollDebounceTask = self`), its `defer { scrollDebounceTask = nil }` must check that the property still points to *this* task before nil-ing it — otherwise it silently cancels the successor task that was assigned after the cancel.
- **Eliminate busy-wait loops with `AsyncStream`.** Replace repeated `DispatchQueue.asyncAfter` polling for state transitions (e.g., waiting for a session to reach `.active`) with an `AsyncStream` that yields on each state change. Use separate Combine subscriptions only for continuously-updating progress properties (elapsed time, counts), not for lifecycle state.
- **Atomically unsubscribe all per-resource subscriptions together.** If a manager keeps several subscription dictionaries keyed by a resource ID (e.g., per-thread Combine cancellables, per-thread tasks), clear all of them in a single `unsubscribeAll(for id:)` method called from one place (teardown, logout, dealloc). Piecemeal unsubscription leaves orphaned subscriptions that continue to fire after the resource is gone.

### Memory Management

- **Avoid retain cycles.** Use `[weak self]` in closures stored by long-lived objects. Be especially careful with closures passed to Combine `sink`, `onReceive`, and completion handlers on network calls.
- **Release heavy resources promptly.** Clear large data (base64 payloads, image data, surface HTML) from memory once it is no longer displayed. Do not accumulate unbounded data across a session.
- **Hard-delete trimmed objects; don't just clear their content.** Stripping a `ChatMessage`'s text/data in-place leaves the object allocated. Use `removeSubrange` (or equivalent) so the objects are fully deallocated and ARC can reclaim the memory. Keep a `hasMoreHistory` flag set to `true` after eviction so pagination can reload the trimmed pages.
- **Register a memory pressure handler.** Long-lived managers that hold large in-memory collections should observe `DispatchSource.makeMemoryPressureSource` (or `ProcessInfo.processInfo.performExpiringActivity`) and proactively evict non-visible data before the OS kills the process.

### Platform-Specific

- **Asynchronous loading.** Load data (network responses, file contents, images) asynchronously off the main thread. Show loading states while data is in flight. Never block the main thread waiting for data.
- **Skeleton placeholders over spinners for content areas.** When a region will display structured content (chat messages, lists, cards), use a skeleton placeholder that mirrors the real layout — matching alignment, dimensions, spacing, and bubble shapes — instead of a generic spinner (`VLoadingIndicator`). This reduces perceived load time and prevents layout shift when real content appears. Use `VSkeletonBone` with `.vShimmer()` for individual bones. Reserve `VLoadingIndicator` / `VBusyIndicator` for small, inline loading states (buttons, toolbar actions) where the final content shape is unknown. See `ChatLoadingSkeleton` for the reference pattern.
- **Profile before optimizing, but follow known patterns.** Use Instruments (Time Profiler, Allocations, SwiftUI view body counters) to validate. However, the patterns above are established project standards — follow them proactively rather than waiting for a performance regression.
- **Background timers: gate on display state and use long polling intervals.** Set background polling intervals to at least 300 s (5 min). Before running expensive evaluation, call `CGDisplayIsAsleep(CGMainDisplayID())` and skip if the display is off. Do **not** use `NSApplication.didBecomeActiveNotification` as an activity gate for LSUIElement / accessory-mode apps — this notification never fires when the app has no dock icon, permanently disabling the feature after first use.
- **AVAudio teardown order.** Always tear down AVAudio resources in the order `removeTap` → `stop` → `reset`. Calling `stop` before `removeTap` leaves the tap dangling and causes a retain cycle that prevents `AVAudioEngine` from being deallocated.

---

## Scroll and Layout Stability

> These rules exist because competing `proxy.scrollTo` calls have caused repeated freezes and crashes in the chat view. Follow them any time you touch scroll-position logic.

- **Cancel auto-scroll tasks immediately on user-initiated scroll.** When the user manually scrolls (up, pagination pull, etc.), cancel the debounce/auto-scroll `Task` synchronously inside the scroll callback — before any `await`. Do not rely on the task noticing cancellation at its next sleep boundary; by then the trailing `proxy.scrollTo` may already have been scheduled, starting a fight with the user's scroll position.
- **Guard scroll `onChange` handlers with a suppression flag during competing operations.** Any `onChange(of: messages.count)` or `onChange(of: streamingScrollTrigger)` that calls `proxy.scrollTo` must be guarded by a flag such as `isSuppressingBottomScroll`. Set that flag to `true` for the duration of pagination scroll-position restoration, and clear it only after the restoration `proxy.scrollTo` has fired. This prevents auto-scroll from racing pagination scroll.
- **Use an in-flight guard to prevent stacking concurrent pagination loads.** A `@State var isPaginationInFlight: Bool` (or equivalent) must gate the pagination sentinel's `onAppear`. Without it, rapid scroll-to-top can enqueue multiple concurrent loads before `isLoadingMoreMessages` is set by the async response, duplicating content and corrupting the history cursor.
- **Allow a layout settle delay before restoring scroll position.** After inserting new messages (pagination prepend), wait at least **32 ms** before calling `proxy.scrollTo(anchor)` so SwiftUI can finish its layout pass. If any inserted content performs an animated height change (e.g., `InlineVideoEmbedCard` at 0.25 s), increase the delay to at least the animation duration (100 ms minimum) — restoring scroll mid-animation lands at the wrong position.
- **Forward scroll/wheel events from gesture-capturing subviews.** `WKWebView` (and other `NSResponder`/`UIResponder` subclasses that capture scroll events) swallow all scroll-wheel input, preventing the enclosing `ScrollView` from scrolling. Subclass the view and override `scrollWheel(_:)` (macOS) / `gestureRecognizerShouldBegin(_:)` (iOS) to forward the event to `nextResponder` / the parent scroll view instead of consuming it.
- **Do not use `.scrollPosition(id:anchor:)` without actively managing the binding.** Declaring a `@State var scrollPositionId: AnyHashable?` and attaching `.scrollPosition(id: $scrollPositionId)` without ever setting or updating the value causes crashes during LazyVStack re-layouts (pagination, streaming). SwiftUI's internal tracking fights with the nil binding. Either fully manage the binding (set it on scroll events, clear it on content changes) or don't use the API at all — the existing `ScrollViewReader` + `proxy.scrollTo()` pattern handles all current scroll needs.
- **Add `os.Logger` diagnostics to complex scroll paths.** Pagination, suppression flag transitions, and scroll position restoration are hard to debug from a crash report alone. Log key events (`[pagination] sentinel appeared`, `[scroll] suppression on/off`, `[scroll] restoring to anchor`) via `os.Logger` with subsystem `com.vellum.vellum-assistant` so they are visible in Console.app without Xcode attached.

---

## Native SwiftUI over Custom AppKit

Prefer built-in SwiftUI primitives over custom `NSViewRepresentable` / AppKit wrappers. Custom AppKit text stacks (NSScrollView + NSClipView + NSTextView) have caused scroll-offset drift bugs that are hard to reproduce and diagnose.

<details>
<summary><strong>SwiftUI vs AppKit reference table</strong></summary>

| Need | Use this | Not this |
|------|----------|----------|
| Multi-line text input (short/medium) | `TextField(axis: .vertical)` + `.lineLimit(1...N)` | Custom `NSTextView` in `NSScrollView` |
| Multi-line text input (scrollable) | `TextField(axis: .vertical)` inside `ScrollView` with GeometryReader height measurement (see chat composer) | Custom AppKit `NSScrollView` + `NSClipView` + `NSTextView` stack |
| Long-form text editing | `TextEditor` (acceptable for editor-like surfaces where the user expects a full text-editing experience, e.g., contact notes, skill editing, tool permission tester) | Custom AppKit `NSScrollView` + `NSClipView` + `NSTextView` stack |
| Vertical centering in text field | Native `TextField` behavior | Custom `NSClipView` subclass |
| Auto-growing height | `ScrollView` + `GeometryReader` on inner content + `.frame(height: clamp(measured, min, max))` | Custom AppKit height sync. Note: `.lineLimit(1...N)` truncates instead of scrolling on macOS when content exceeds N lines — only use it for short-form inputs where truncation is acceptable (e.g., `VTextEditor`) |
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
- Good: `/// Cancellable task for the delayed hover trigger on the collapsed thread section.`
- Bad: `// conversationItem — moved to Sidebar/SidebarConversationItem.swift (standalone view)`

---

## SwiftUI Type-Checker Complexity

Swift's type checker has quadratic complexity with chained view modifiers. Complex view bodies will cause "unable to type-check this expression in reasonable time" build errors.

**Prevention:**
- Extract groups of related views into separate `@ViewBuilder` methods (~50 lines max each).
- If you have 3+ `.onKeyPress()` handlers on a single view, extract the view + handlers into its own `@ViewBuilder`.
- Use computed properties (`private var foo: some View`) for complex sub-hierarchies.

**`.onKeyPress()` API signatures (macOS 14+):**
- `.onKeyPress(.key) { return .handled }` — no-argument closure `() -> KeyPress.Result`
- `.onKeyPress(.key, phases: .down) { press in return .handled }` — use this when you need `press.modifiers`
- These are different overloads; using the wrong signature causes confusing build errors.

---

## Common SwiftUI Pitfalls

| Pitfall | Why it's bad | Do this instead |
|---------|-------------|----------------|
| `[weak context]` in NSViewRepresentable | `Context` is a struct, not a class — won't compile | Capture `context.coordinator` in a local `let` |
| `GeometryReader` as layout container | Expands to fill available space, breaking intrinsic sizing | Use `GeometryReader` only in `.background()` for measurement |
| View in flexible container without size constraint | View expands to fill parent (e.g., ZStack) | Add `.fixedSize(horizontal: false, vertical: true)` to hug content |
| Mutable array in `DispatchGroup` callbacks | Race condition — callbacks may run on different threads | Wrap each append in `DispatchQueue.main.async`; for new code, prefer actor isolation or `@Sendable` closures |
| Duplicated send/action logic across code paths | Paths drift out of sync (e.g., AppKit bridge vs SwiftUI handler) | Extract shared logic into a single function both paths call |
| `.scrollPosition(id:)` with unmanaged binding | Nil binding fights SwiftUI's internal tracking, crashes on re-layout | Use `ScrollViewReader` + `proxy.scrollTo()`, or fully manage the binding |
| Strong closure capture on window | Retain cycle if window outlives view | Use `[weak coordinator]` or clear in `dismantleNSView` |
| `@Observable` dictionary as per-entity store | Any key mutation invalidates all views reading the dictionary | Use per-entity `@Observable` wrapper objects; mutate their properties instead of the dictionary |
| GeometryReader on ScrollView `.background` measuring parent frame | Measures the ScrollView's proposed size (parent frame), not content intrinsic height — creates feedback loop where state derived from the measurement drives the frame that's being measured | Place GeometryReader on the *inner content* (inside the ScrollView), and reset all derived state (`contentHeight`, `isExpanded`) atomically when content clears |

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
  - **Components** — `Components/` contains composed, higher-level components: `VCard`, `VEmptyState`, `VSplitView`, `VSidePanel`, `VToolbar`, `VTabBar`, `VSegmentedControl`, `VWaveformView`, etc.
  - **Modifiers** — `Modifiers/` contains reusable view modifiers: `CardModifier`, `HoverEffect`, `PanelBackground`, `InlineWidgetCardModifier`.
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

### Adding New Shared Components
- If a needed component does not exist, add it to the appropriate `DesignSystem/` subdirectory (`Core/` for primitives, `Components/` for composed elements, `Modifiers/` for view modifiers).
- Follow existing naming conventions: prefix with `V`, use descriptive names (for example `VProgressBar`, `VAvatar`).
- New components must be reusable and platform-agnostic; do not embed platform-specific code.
- Do not add `#Preview` / `PreviewProvider` blocks. Add or update the corresponding section in `Gallery/` so the component is represented in the catalog.
- If you create a component inline in a feature and it could be reused elsewhere, extract it into the design system before merging.

### Avoiding Duplication
- Do not create one-off UI elements that duplicate existing design system components. Search the `DesignSystem/` directory before building.
- When a feature needs a slight variation of an existing component, extend the component with a new parameter or style rather than forking it.

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

## Docs Anti-Drift
- Avoid brittle hardcoded counts, version claims, or roadmap placeholders in client READMEs unless they are generated automatically. Prefer evergreen wording (e.g., "iOS-specific integration tests" instead of "70 iOS-specific tests").
- When updating documentation, verify claims against the current codebase rather than copying from stale sources.

---

## Maintenance

- Refresh this guidance after major Apple OS or SwiftUI releases (for example, post-WWDC).
- **When fixing a bug, consider whether the root cause represents a generalizable pitfall.** If an API was misused in a way that compiled but caused runtime crashes, freezes, or subtle misbehavior — and another developer or agent could plausibly make the same mistake — add a rule to the relevant section of this file (or the pitfalls table). This file is the team's collective memory for hard-won lessons; keeping it current prevents repeat bugs.
