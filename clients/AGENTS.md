# Clients — Agent Guidance

## Scope and Precedence
- Applies to all client code in `clients/` (macOS, browser extensions, shared).
- Platform-specific docs (for example `clients/macos/AGENTS.md`) override or extend this file.
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
- Accessibility is required: see [Accessibility](#accessibility) below for detailed rules derived from past fixes.
- Localize user-facing strings; format dates/units with locale-aware formatters.
- Privacy: request the minimum permissions; never log sensitive user content.

### Deprecated API Watchlist

APIs that still compile without warning but are deprecated by Apple. Do not introduce new usages.

| Deprecated | Replacement | Since | Status | Why |
|---|---|---|---|---|
| `.foregroundColor()` | `.foregroundStyle()` | macOS 12 | **Fully migrated** — do not use `.foregroundColor()` anywhere | `.foregroundStyle()` accepts any `ShapeStyle` (gradients, materials, hierarchical styles), not just `Color`. Drop-in replacement for `Color` values. |

### Accessibility

Every interactive element must be usable via VoiceOver and keyboard navigation. These rules come from real bugs fixed in the codebase — treat them as a checklist when building or modifying components.

**References:**
- [Apple — Accessibility for SwiftUI](https://developer.apple.com/documentation/swiftui/accessibility)
- [WWDC24 — Catch up on accessibility in SwiftUI](https://developer.apple.com/videos/play/wwdc2024/10073/)
- [Apple — Supporting VoiceOver in your app](https://developer.apple.com/documentation/accessibility/supporting-voiceover-in-your-app)
- [Apple HIG — Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)

#### Labels

- **Every interactive element needs an accessibility label.** Icon-only buttons, icon-only menu triggers, and close/dismiss buttons must have `.accessibilityLabel()`. Text buttons get their label from the `Text` content automatically — do not override it with an empty string.
  - Bad: `.accessibilityLabel(iconOnly != nil ? label : "")` — this blanks the label for text buttons.
  - Good: `.accessibilityLabel(label)` — always expose the label regardless of visual variant.
- **Descriptive labels for contextual actions.** Use labels that include the context: `"Remove \(label) filter"`, `"Delete memory"`, `"More options"` — not just `"Close"` or `"Delete"`.
- **Accessibility labels must match the visual content.** If a value is clamped for display (e.g., a progress ring), the accessibility label must use the same clamped value so VoiceOver reports what the user sees.

#### Hidden & Conditional Elements

- **Opacity-hidden elements need `.allowsHitTesting(false)`.** When using `.opacity(isHovered ? 1 : 0)` to show/hide controls, also add `.allowsHitTesting(isHovered)` to prevent invisible elements from intercepting taps.
- **Opacity-hidden elements need `.accessibilityHidden()`.** Add `.accessibilityHidden(!isVisible)` so VoiceOver does not announce elements the user cannot see. Without this, VoiceOver users encounter "phantom" buttons.
- **Decorative dividers and separators must be hidden.** Add `.accessibilityHidden(true)` to visual-only elements like `VMenuDivider`, section separators, and decorative rules.

#### Custom Interactive Elements

- **Custom tap targets need `.accessibilityAddTraits(.isButton)` and `.accessibilityAction`.** When using `.onTapGesture` instead of `Button`, VoiceOver cannot activate the element. Add:
  ```swift
  .accessibilityElement(children: .combine)
  .accessibilityLabel(label)
  .accessibilityAddTraits(.isButton)
  .accessibilityAction { action() }
  ```
- **Disabled items must guard their accessibility actions.** If a menu item or button is disabled, the `.accessibilityAction` closure must check `isEnabled` before executing: `guard isEnabled else { return }`.
- **Stateful controls need `.accessibilityValue()` and traits.** Toggle-like or selectable items should expose state: `.accessibilityAddTraits(isActive ? [.isSelected] : [])` and `.accessibilityValue(valueText)`.
- **Section headers need `.accessibilityAddTraits(.isHeader)`.** Mark section titles in menus and lists with the header trait so VoiceOver users can navigate by section.

#### Custom Panels and Popovers (AppKit)

- **NSPanel-based menus must post VoiceOver notifications.** When presenting a custom `NSPanel` (e.g., `VMenuPanel`), post `NSAccessibility.post(element: panel, notification: .created)` and move VoiceOver focus to the first child element.
- **Do not wrap `NSHostingView` in intermediate container views.** Use `NSHostingView` directly as `contentView` to preserve the natural `NSPanel → NSHostingView → SwiftUI` accessibility hierarchy. Wrapper views (e.g., `FirstMouseView`) break VoiceOver navigation.
- **Use `.setAccessibilityRoleDescription("menu")` instead of `.setAccessibilityRole(.menu)` for custom panels.** The `.menu` role expects native `NSMenu`-style children that SwiftUI cannot provide; a role *description* preserves the announcement without breaking navigation.

### State Management: @Observable vs ObservableObject

For new view models and state objects targeting macOS 15+, prefer the `@Observable` macro (Observation framework) over `ObservableObject`.

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
| Leaf-node view models observed by a single view | Hub objects that subscribe to many child `objectWillChange` publishers |
| Per-entity state objects in dictionary stores | Classes conforming to protocols requiring `ObservableObject` (e.g., `SessionOverlayProviding`) |

<details>
<summary><strong>Classes migrated to @Observable</strong></summary>

The following classes have been migrated from `ObservableObject` to `@Observable`:

**macOS-only:** QuickInputTextModel, DevModeManager, RecordingHUDViewModel, NavigationHistory, AmbientAgent, DocumentManager, E2EStatusOverlayViewModel, WatchSession, SurfaceViewModel, SurfaceManager, AppListManager, TerminalSessionManager, MessageAudioPlayer, ContactsViewModel, OpenAIVoiceService, SkillsManager, MessageListScrollState, ConversationManager, ConversationListStore, ConversationSelectionStore, ConversationActivityStore, MainWindowState, VoiceModeManager, UpdateManager, AssistantFeatureFlagStore

**Shared library:** InlineVideoEmbedStateManager, ContactsStore, MemoryItemsStore, ChannelTrustStore, ChatErrorManager, ChatGreetingState, TaskProgressOverlayManager, ChatAttachmentManager, ChatMessageManager, ChatViewModel, GatewayConnectionManager

</details>

<details>
<summary><strong>Classes intentionally remaining ObservableObject</strong></summary>

These classes stay `ObservableObject` because they have deep Combine integration, complex `objectWillChange` forwarding, or protocol requirements that make migration impractical without broader refactoring:

| Class | Rationale |
|---|---|
| `SettingsStore` | Heavy `UserDefaults.publisher` + Combine pipelines |
| `RecordingManager` | Audio capture Combine pipelines |
| `RecordingSourcePickerViewModel` | ScreenCaptureKit async sequences + Combine |
| `HostCuSessionProxy` | Conforms to `SessionOverlayProviding` protocol requiring `ObservableObject` |
| `ToolPermissionTesterModel` | Combine-based test execution pipeline |

</details>

#### @Observable migration patterns

**`@ObservationIgnored` for non-reactive bookkeeping.** Mark stored properties that should not trigger view updates with `@ObservationIgnored`. Use this for: Combine cancellables (`Set<AnyCancellable>`), background `Task` handles, delegate/callback closures, internal caches, and constants. Example: `@ObservationIgnored private var cancellables = Set<AnyCancellable>()`.

**`@ObservationIgnored` enables deinit access on `@MainActor @Observable` classes.** The `@Observable` macro synthesizes getter/setter pairs that create actor isolation conflicts in `deinit` ([swift#79551](https://github.com/swiftlang/swift/issues/79551)). To cancel owned tasks in `deinit`, mark them `@ObservationIgnored` so they remain plain stored properties that `deinit` can access. Always explicitly cancel unstructured `Task {}` in `deinit` — do not rely solely on `[weak self]` cleanup, as the task continues running until its next cancellation check ([WWDC23 — Beyond the basics of structured concurrency](https://developer.apple.com/videos/play/wwdc2023/10170/)).
```swift
@MainActor @Observable final class MyState {
    @ObservationIgnored var myTask: Task<Void, Never>?
    deinit { myTask?.cancel() }
}
```

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
Prefer migrating the parent to `@Observable` so the bridge becomes unnecessary (reading an `@Observable` child's properties from views naturally tracks through the nested chain).

**Computed property forwarding.** When both source and target are `@Observable`, computed properties that read from an `@Observable` dependency automatically participate in observation tracking — no manual bridging needed.

**Migration:** Existing `ObservableObject` types should be migrated opportunistically. Use Combine (`@Published`, `sink`, `onReceive`) only for reactive stream processing (SSE event streams, debounce pipelines, `UserDefaults.publisher`) — not for simple state management.

**Previews:** Do not add `#Preview` or `PreviewProvider` blocks. Use the Component Gallery as the single visual review surface. If you encounter existing `#Preview` blocks, remove them.

#### ConversationManager 3-Store Architecture

`ConversationManager` is decomposed into three focused `@Observable` stores, each owning a distinct domain of state. This follows Apple's recommendation to use small, focused model objects for property-level tracking ([Managing model data in your app](https://developer.apple.com/documentation/swiftui/managing-model-data-in-your-app), [WWDC21 — Demystify SwiftUI](https://developer.apple.com/videos/play/wwdc2021/10022/)).

| Store | Responsibility | Key State |
|---|---|---|
| `ConversationListStore` | Conversation and group arrays, sidebar-derived computed properties, pagination, grouping, pinning, ordering, seen/unseen state | `conversations`, `groups`, `visibleConversations`, `groupedConversations`, `unseenVisibleConversationCount` |
| `ConversationSelectionStore` | Active conversation selection, draft mode, ChatViewModel LRU cache, pop-out window pinning, restoration | `activeConversationId`, `draftViewModel`, `chatViewModels`, `vmAccessOrder`, `pinnedViewModelIds` |
| `ConversationActivityStore` | Per-conversation busy flags, interaction states, active message count | `busyConversationIds`, `conversationInteractionStates`, `activeMessageCount` |

`ConversationManager` acts as a thin facade wiring the three stores together with app-layer dependencies (daemon connection, fork/detail clients, conversation restorer). Views continue to inject `ConversationManager` via `@Environment` — the facade forwards all public properties and methods to the appropriate store. Cross-cutting operations that touch multiple stores (fork, archive, background-conversation creation) live on the facade.

**Why this matters:** With `@Observable`, property-level tracking means a sidebar view reading `conversations` is not invalidated when `activeConversationId` changes (owned by a different store). This eliminates the broad invalidation cascade that previously caused 100+ sidebar row rebuilds on every conversation switch.

**Cross-store observation rule:** Computed properties on one `@Observable` store must not read stored properties from another `@Observable` store — this silently bridges observation dependencies across the isolation boundary, defeating the purpose of the decomposition. If cross-store data is needed, use a cached stored property synchronized via a callback from the source store, with an equality guard (`!=`) to suppress no-op writes. See `ConversationSelectionStore.activeConversation` / `syncActiveConversationCache()` and `ConversationListStore.onDerivedPropertiesRecomputed` for the reference pattern. ([Observation framework — access tracking](https://developer.apple.com/documentation/observation))

---

## Performance and Resource Management

### View Bodies and Rendering

- **View bodies must be lightweight.** Never perform I/O, network calls, or heavy computation inside a SwiftUI view body. This includes filtering, sorting, and data transformation — do that work in the ViewModel (asynchronously), not inline during render. Cheap display-time formatting (e.g., `Date.formatted(...)`, locale-aware unit strings) is fine in the view since it must react to locale/calendar changes. Defer expensive work to `task {}`, `onAppear`, or background actors.
- **Lazy containers for large collections.** Use `LazyVStack`, `LazyHStack`, `LazyVGrid` instead of eager equivalents when the item count is unbounded or large. In particular, avoid `VStack`/`HStack` inside a `ScrollView` for large or unbounded data-driven lists — eager loading kills scroll performance. Small, fixed-size lists where visibility-sensitive logic (e.g., `onAppear` pagination triggers) matters may use eager containers intentionally. See `clients/macos/AGENTS.md` §§ "No `.frame(maxWidth:)` …" for the FlexFrame anti-pattern that compounds with lazy containers (mechanically enforced in CI via `clients/scripts/check-flexframe.sh`).
- **Keep modifier chains lean.** Every SwiftUI modifier wraps its content in a new view value. Long chains of redundant or duplicated modifiers deepen the view tree and increase diffing cost. Group related modifiers, remove redundant ones (e.g., don't set `.font` on every row when the parent already sets it), and extract heavily-modified subtrees into standalone `@ViewBuilder` methods.
- **Scope observation narrowly.** Only observe the specific properties a view needs. Prefer granular `@Observable` properties or `withObservationTracking` over observing an entire store that publishes on unrelated changes. When a view reads `@Observable` properties from many different objects, extract logical sections (toolbar, overlays, content) into standalone child `View` structs — each child creates its own [observation tracking scope](https://developer.apple.com/videos/play/wwdc2023/10149/) so changes to one section's state don't re-evaluate the entire parent body. **Note:** private `@ViewBuilder` functions do NOT create separate observation scopes — they execute during the caller's `body` evaluation, so all their `@Observable` reads are tracked in the caller's scope. Use standalone `View` structs or [`ObservationBoundaryView`](https://developer.apple.com/videos/play/wwdc2023/10149/) (deferred `@escaping @ViewBuilder` closure) when extraction into a full `View` struct is impractical.
- **Cache derived booleans from high-frequency collections.** Reading `.isEmpty` or `.count` on an `@Observable` stored property [tracks the property, not the value](https://developer.apple.com/videos/play/wwdc2023/10149/) — any mutation invalidates the view even when the derived boolean hasn't changed. For frequently-mutated collections, maintain a separate stored boolean with a write-only-on-change guard (`if new != old { prop = new }`). This also applies to modifiers like `.onChange(of:)` — if the `of:` expression reads a collection property, the outer body observes it.
- **Use `.task` + async sequences instead of `.onReceive` for `NotificationCenter`.** Each `.onReceive` modifier adds a generic wrapper layer to the view type and exists only for side effects — no rendering value. Use a single [`.task`](https://developer.apple.com/documentation/swiftui/view/task(priority:_:)) with [`NotificationCenter.notifications(named:)`](https://developer.apple.com/documentation/foundation/notificationcenter/notifications(named:object:)) async sequences instead. `.task` has identical lifecycle semantics (auto-cancelled on view disappear) without inflating the view type.
- **Enable non-contiguous layout on TextKit 1 stacks in `NSViewRepresentable`.** When constructing an `NSLayoutManager` for an `NSTextView` hosted via `NSViewRepresentable`, set `layoutManager.allowsNonContiguousLayout = true`. The default (`false`) forces full-document glyph layout from character 0 on the main thread whenever a glyph range is queried — which happens the first time the text view is attached to its hosting view (`setDocumentView:` / `addSubview:` → `_setSuperview:` → `setNeedsDisplayInRect:` → `_glyphRangeForBoundingRect:`). Reference: [`NSLayoutManager.allowsNonContiguousLayout`](https://developer.apple.com/documentation/appkit/nslayoutmanager/allowsnoncontiguouslayout). **Exception — streaming text with a separate measurement stack:** when the representable measures height via a sibling TextKit stack that always fully lays out every glyph (e.g. `ensureLayout(for:)` + `usedRect(for:)`), the measured frame assumes the render stack will also lay out every glyph in that rect. Non-contiguous layout leaves glyphs pending until the view scrolls or draws them, which races with streaming updates — producing a gap (render paints a smaller laid-out region inside the correct frame) and then overlap (the next sibling is placed via the measured frame and the lazy glyphs later paint outside it). In that case set `allowsNonContiguousLayout = false` and document why. See `clients/shared/DesignSystem/Components/Display/SelectableTextView.swift` (lines 180–205) for the canonical example; `VCodeView` / `HighlightedTextView` still opt into non-contiguous layout independently because they do not share this measurement model.
- **Prefer line-count math over `ensureLayout(for:)` for `sizeThatFits` when line wrapping is disabled and line height is pinned.** If the TextKit 1 stack uses an unbounded-width `NSTextContainer` (so lines never wrap) and the paragraph style pins `minimumLineHeight == maximumLineHeight`, the total height is exactly `lineCount * lineHeight + insets` — no glyph layout required. This avoids an O(glyph count) main-thread layout pass that SwiftUI would otherwise re-run on every cell during `LazyVStack` layout. Reference: [`NSLayoutManager.defaultLineHeight(for:)`](https://developer.apple.com/documentation/appkit/nslayoutmanager/defaultlineheight(for:)).
- **Decouple `NSTextContainer` from the view frame when an `NSViewRepresentable` hands SwiftUI a precomputed size.** If the caller applies `.frame(width:height:)` from a static measurement helper (`measureSize`), set [`NSTextContainer.widthTracksTextView`](https://developer.apple.com/documentation/appkit/nstextcontainer/widthtrackstextview) to `false`, size the container explicitly from the same `maxWidth` used to measure, and propagate `maxWidth` changes onto `containerSize` in `updateNSView`. Do not pair this path with `autoresizingMask = [.width]`. The default (`widthTracksTextView = true`, autoresize on) causes every SwiftUI-driven `setFrameSize` — window resize, eager `VStack` measurement — to forward onto the layout manager, triggering `_fillLayoutHoleForCharacterRange`: a synchronous main-thread relayout that is O(glyph count). Reference: [`NSTextView.isHorizontallyResizable`](https://developer.apple.com/documentation/appkit/nstextview/ishorizontallyresizable).
- **Memoize `sizeThatFits` (and sibling measurement calls) in `NSViewRepresentable` views placed in lazy containers.** Any `NSViewRepresentable` that hosts a TextKit stack (`NSLayoutManager` + `NSTextContainer`) and can appear inside a `LazyVStack` / `LazyHStack` / `List` cell must cache its last measurement. [`NSLayoutManager.ensureLayout(for:)`](https://developer.apple.com/documentation/appkit/nslayoutmanager/ensurelayout(for:)) is O(glyph count) and runs synchronously on the main thread, and SwiftUI calls [`sizeThatFits(_:nsView:context:)`](https://developer.apple.com/documentation/swiftui/nsviewrepresentable/sizethatfits(_:nsview:context:)) on every visible cell on every layout pass (scroll, resize, streaming edit). Cache at minimum on `(textStorage.length, proposalWidth)`; for attribute-sensitive paths (static measurement helpers, highlighted content) key on the `NSAttributedString` itself and fall through to [`NSAttributedString.isEqual(_:)`](https://developer.apple.com/documentation/foundation/nsattributedstring/isequal(_:)) for identity — `NSAttributedString.hash` alone admits collisions and surfaces as wrong-height cells. Invalidate at every text-storage mutation site (text apply, edit callbacks, async highlight/formatting completions). Reference: `SelectableTextView`. When line wrapping is disabled and line height is pinned (as in `VCodeView.VCodeTextView` and `HighlightedTextView.CodeTextView`), prefer the line-count math above over a cached `ensureLayout` call.
<details>
<summary><strong>Per-entity observation and dictionary patterns</strong></summary>

- **Use per-entity `@Observable` objects for dictionary-stored data.** `@Observable` tracks at the property level, not per dictionary key. A `var items: [Key: Value]` property invalidates *all* readers when *any* key changes. When views display individual entries (e.g., per-subagent event lists), store each entry's data in its own `@Observable` class instance (e.g., `var states: [String: EntityState]` where `EntityState` is `@Observable`). Views that read a specific `EntityState`'s properties are only invalidated when *that* instance changes — not when a sibling entry is mutated. The dictionary itself should only be mutated when entries are added or removed (infrequent), while high-frequency updates go through the per-entity object's properties.
- **Use targeted `@Published` + `.removeDuplicates()` instead of forwarding `objectWillChange`.** Wiring one object's `objectWillChange` publisher into another's invalidates the entire SwiftUI tree on every emission. Expose a narrow `@Published var activeMessageCount: Int` (or equivalent) and attach `.removeDuplicates()` so downstream views only re-render when the value actually changes.

</details>

### High-Frequency Updates

- **Coalesce high-frequency Combine publishes.** When a Combine publisher fires at high frequency (for example per-token streaming), coalesce updates with `throttle`, `debounce`, or a manual coalescing window to avoid render churn. Use **100 ms minimum** as the default. A **50 ms minimum** is acceptable when the body evaluation cost has been verified to be sub-millisecond.
- **Use computed properties for derived `@Observable` state.** On `@Observable` classes, derive values from stored properties via computed properties — the Observation framework [traces through to the underlying stored property](https://developer.apple.com/documentation/observation), so views share a single dependency. Do **not** sync a stored property from another stored property via Combine or `withObservationTracking` — this creates a second observation source and causes [double-invalidation](https://developer.apple.com/videos/play/wwdc2023/10149/). Reserve stored-property caching for genuinely expensive work (sorting, JSON sizing, large-collection transforms) that cannot run in a view body evaluation; in that case, update the cache off the main thread and coalesce writes.
- **Coalesce `@Observable` stored-property mutations during streaming.** When a stored property on an `@Observable` class mutates at high frequency (e.g. per-token), batch mutations with a coalescing window so SwiftUI body evaluations are throttled. Use **100 ms minimum** as the default; **50 ms** is acceptable for verified-cheap body paths.
- **Defer synchronous fan-out from `@Observable` property mutations.** Do not call [`NotificationCenter.post`](https://developer.apple.com/documentation/foundation/notificationcenter/1410472-post) or other synchronous broadcast mechanisms inside a setter or method that mutates an `@Observable` stored property. The `@Observable` `willSet` already fires all [`withObservationTracking` `onChange` callbacks synchronously](https://developer.apple.com/documentation/observation/withobservationtracking(_:onchange:)); adding `NotificationCenter.post` (which dispatches all observer callbacks inline) compounds the main-thread cost — especially when per-instance observers (e.g. one per view model or per rendered attachment) push the total count into double digits. Wrap fan-out in `Task { @MainActor in }` to defer it to the next run-loop turn.
- **Read the macro-synthesised `_<propertyName>` backing storage when guarding a self-write to an `@Observable` property.** The synthesised getter calls [`_$observationRegistrar.access(_:keyPath:)`](https://developer.apple.com/documentation/observation/observationregistrar/access(_:keypath:)) and registers a tracking dependency on the current `withObservationTracking` context. Reading `_<propertyName>` skips it.
- **Defer and coalesce high-frequency state-machine writes to `@Observable` properties.** When a method on an `@Observable` class is called from a periodic loop, retry, or external event source and writes a property observed by many consumers, schedule the write onto the next `@MainActor` turn behind a single in-flight `Task<Void, Never>?`. Back-to-back calls collapse to the most-recent target. Async public APIs `await` the task; sync public APIs flush inline. Reference: [WWDC21 — "Protect mutable state with Swift actors"](https://developer.apple.com/videos/play/wwdc2021/10133/).
- **Scope `UserDefaults` observation with `publisher(for:)` + debounce.** Do not subscribe to `UserDefaults.didChangeNotification` (app-wide) to watch a single key — it fires on every defaults write across the whole app. Use `UserDefaults.publisher(for: \.myKey)` with a 100 ms `.debounce` to limit scope and frequency.

### Concurrency and Task Management

- **Prefer async/await and structured concurrency.** Use `Task {}` with proper cancellation over raw GCD. `Task.detached` is appropriate when you need to **escape actor isolation** for CPU-bound work (e.g., image resize, data encoding, file I/O from a `@MainActor` context). **Note:** The project has the Swift 6.2 toolchain but runs in **Swift 5 language mode** (`swiftLanguageModes: [.v5]` in Package.swift). `Task.detached` is the correct pattern for escaping actor isolation in this mode. [`@concurrent` functions (SE-0461)](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0461-async-function-isolation.md) are a cleaner alternative but require enabling the `NonisolatedNonsendingByDefault` feature flag, which changes the behavior of all `nonisolated async` functions across the codebase — a separate migration step. (Ref: [WWDC25 — Embracing Swift concurrency](https://developer.apple.com/videos/play/wwdc2025/268/))
- **Yield to the run loop before heavy synchronous work in event handlers.** When a `.onTapGesture`, `Button` action, or similar user-input handler both mutates state that drives a visible UI change *and* calls into expensive synchronous work (ViewModel init, Combine observer wiring, large parse), wrap the heavy call in `Task { @MainActor in ... }`. SwiftUI commits invalidated views only after the synchronous handler returns — without the yield, the user sees no response to the click until the slow work finishes, even though the state change itself was instant. Target <100 ms click-to-paint latency per [Apple HIG — Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback).
- **Always cancel subscriptions and tasks.** Store `AnyCancellable` tokens and cancel them in `deinit` or `onDisappear`. For `Task {}` started in `onAppear`, cancel in `onDisappear`. For `@StateObject` / `@ObservedObject` view models, cancel in `deinit`.
- **Remove observers and listeners.** Unsubscribe from `NotificationCenter`, KVO, and any custom event systems when the owning object is deallocated or the view disappears. Prefer the `task {}` modifier with implicit cancellation over manual `NotificationCenter.addObserver`.
- **Use an explicit capture list for `@Sendable` closures inside `mutating` struct methods.** `self` is `inout` inside a `mutating` method, and implicitly capturing it from a `@Sendable` closure (e.g. `withTaskCancellationHandler`'s `onCancel:`) is rejected in Swift 6 language mode. Write `{ [field] in field() }` to capture the needed value directly. Refs: [SE-0035](https://github.com/apple/swift-evolution/blob/main/proposals/0035-limit-inout-capture.md), [`SendableClosureCaptures`](https://docs.swift.org/compiler/documentation/diagnostics/sendable-closure-captures/).
<details>
<summary><strong>Task lifecycle patterns (deferred work, cancellation guards, cleanup)</strong></summary>

- **Store deferred async work as a cancellable `Task`, not `DispatchQueue.asyncAfter`.** A `DispatchQueue.asyncAfter` block cannot be cancelled. Replace it with `Task { try? await Task.sleep(...); guard !Task.isCancelled else { return }; ... }` stored in a `Task<Void, Never>?` property so it can be cancelled cleanly in `deinit` or `onDisappear`.
- **Add `guard !Task.isCancelled else { return }` after every `Task.sleep` in animation or scroll tasks.** A sleep inside a debounce task is a cancellation point; without the guard the trailing action (e.g., `proxy.scrollTo`) can fire after the task was explicitly cancelled, causing competing UI mutations.
- **Guard `defer` cleanup blocks against clobbering a newer reference.** If a task stores itself in a shared property (e.g., `scrollDebounceTask = self`), its `defer { scrollDebounceTask = nil }` must check that the property still points to *this* task before nil-ing it — otherwise it silently cancels the successor task that was assigned after the cancel.
- **Eliminate busy-wait loops with `AsyncStream`.** Replace repeated `DispatchQueue.asyncAfter` polling for state transitions (e.g., waiting for a session to reach `.active`) with an `AsyncStream` that yields on each state change. Use separate Combine subscriptions only for continuously-updating progress properties (elapsed time, counts), not for lifecycle state.
- **Atomically unsubscribe all per-resource subscriptions together.** If a manager keeps several subscription dictionaries keyed by a resource ID (e.g., per-conversation Combine cancellables, per-conversation tasks), clear all of them in a single `unsubscribeAll(for id:)` method called from one place (teardown, logout, dealloc). Piecemeal unsubscription leaves orphaned subscriptions that continue to fire after the resource is gone.
- **Replace `DispatchQueue.main.asyncAfter` with `Task.sleep` in new code.** `asyncAfter` blocks cannot be cancelled. Use `Task { try? await Task.sleep(nanoseconds: N); guard !Task.isCancelled else { return }; ... }` and store the task in a `Task<Void, Never>?` property for cancellation. In SwiftUI views, prefer `.task { }` or `.task(id:)` modifiers which auto-cancel on view removal or identity change. **Note:** `DispatchQueue.main.async { }` (no delay) is still valid for synchronous main-thread hops. **Note:** `DispatchWorkItem`-based cancelable patterns (e.g., SettingsStore verification timeouts) are a separate idiom — do not blindly convert those to `Task.sleep`.

</details>

### @MainActor Isolation Boundaries

**Default to `@MainActor` for stateful types.** Only escape to background for CPU-bound work that measurably blocks the UI (JSON decode, image processing, compression). This follows Apple's recommended architecture ([WWDC25 — Embracing Swift concurrency](https://developer.apple.com/videos/play/wwdc2025/268/)): keep mutable state on the main actor for thread safety, and offload only the expensive computation. This principle applies regardless of language mode.

**Two failure modes to avoid:**
1. **Over-isolation** — putting `@MainActor` on a type is correct, but running CPU-bound work *inside* it without offloading blocks the UI. Fix: offload the expensive method, not the whole type.
2. **Under-isolation** — making a stateful class itself `nonisolated` removes all thread safety. Concurrent access to its stored properties is a data race. `nonisolated` is appropriate for stateless types (enums with static methods, structs, pure-function utilities) and for individual `static let` constants of `Sendable` type when they need to be read from off-actor contexts (e.g. a `Task.detached` prefetch). See [SE-0434](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0434-global-actor-isolated-types-usability.md).

**Offloading CPU-bound work:** Use `Task.detached(priority:)` to escape `@MainActor` for the smallest piece of work that needs it. This is the correct approach for the project's current Swift 5 language mode. If the project later enables the `NonisolatedNonsendingByDefault` feature flag (or migrates to Swift 6 language mode), `Task.detached` calls can be replaced with [`@concurrent` functions (SE-0461)](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0461-async-function-isolation.md), which achieve the same isolation escape with structured concurrency benefits.

```swift
@MainActor
final class MyClient {
    func process(_ data: Data) async {
        let prepared = prepareData(data)              // cheap — stays on main
        let result = await Task.detached(priority: .userInitiated) {
            HeavyDecoder().decode(prepared)            // expensive — runs off main
        }.value
        self.handleResult(result)                      // state update — back on main
    }
}
```

**When to use a custom `actor` instead:** Only when data genuinely needs its own isolation domain — i.e., long-lived background state accessed from multiple concurrent tasks where main-actor serialization would be a bottleneck. This is rare in app code.

**Serialize observer-triggered heavy work.** When a single event (e.g., network reconnection, notification) triggers N independent observers that each schedule expensive `@MainActor` work, serialize them through a queue with [`Task.yield()`](https://developer.apple.com/documentation/swift/task/yield()) between iterations. Without serialization, N simultaneous responses arrive near-simultaneously and saturate the main actor. See `ConversationRestorer.drainReconnectHistoryQueue()` for the reference implementation.

References:
- [WWDC25 — Embracing Swift concurrency](https://developer.apple.com/videos/play/wwdc2025/268/)
- [WWDC25 — Explore concurrency in SwiftUI](https://developer.apple.com/videos/play/wwdc2025/266)
- [SE-0461 — `@concurrent` functions](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0461-async-function-isolation.md)
- [WWDC21 — Protect mutable state with Swift actors](https://developer.apple.com/videos/play/wwdc2021/10133/)
- [Apple — DispatchQueue.sync](https://developer.apple.com/documentation/dispatch/dispatchqueue/sync(execute:)-3gef0) (deadlock risk)

### Memory Management

- **Avoid retain cycles.** Use `[weak self]` in closures stored by long-lived objects. Be especially careful with closures passed to Combine `sink`, `onReceive`, and completion handlers on network calls.
- **Release heavy resources promptly.** Clear large data (base64 payloads, image data, surface HTML) from memory once it is no longer displayed. Do not accumulate unbounded data across a session.
- **Hard-delete trimmed objects; don't just clear their content.** Stripping a `ChatMessage`'s text/data in-place leaves the object allocated. Use `removeSubrange` (or equivalent) so the objects are fully deallocated and ARC can reclaim the memory. Keep a `hasMoreHistory` flag set to `true` after eviction so pagination can reload the trimmed pages.
- **Don't invalidate cached state on a hot path to force a refetch.** When an `isLoaded`-style flag already gates a load, flipping it to `false` on every thread switch / tab switch / reselection runs a full refetch each time and leaves the cached UI rendering stale (or empty, if you also strip content) until the network round-trip resolves. If the data really does need refreshing, prefer an on-demand per-item rehydration API (see `ChatViewModel.rehydrateMessage(id:)`) over a blanket reload. The LRU cache, `trimOldMessagesIfNeeded`, and the memory-pressure handler are sufficient memory safeguards on their own — don't stack a preemptive trim on top that defeats them.
- **Register a memory pressure handler.** Long-lived managers that hold large in-memory collections should observe `DispatchSource.makeMemoryPressureSource` and proactively evict non-visible data before the OS kills the process.
- **Defer deallocation of complex `@Observable` graphs off the main thread during cache eviction.** When an LRU cache drops the last strong reference to an `@Observable` object with a deep sub-object tree, the synchronous `ObservationRegistrar.Extent.deinit` cascade can stall the main thread — especially under memory pressure. Capture evicted objects in a local array and hand them to `Task.detached { withExtendedLifetime(objects) {} }` so the deinit chain runs on the cooperative thread pool. Verify all `deinit` operations are `nonisolated` and thread-safe before applying. Ref: [ObservationRegistrar source](https://github.com/swiftlang/swift/blob/main/stdlib/public/Observation/Sources/Observation/ObservationRegistrar.swift).

### Loading States

- **Use skeleton placeholders, not spinners, for complex data loads.** When loading structured or composite content — lists, cards, detail views, dashboards, multi-section screens — always use skeleton placeholders that approximate the final layout. Skeletons give users a spatial preview of what's coming, reduce perceived wait time, and eliminate layout shift when real content appears. Use `VSkeletonBone` with `.vShimmer()` for individual placeholder bones and compose them to mirror the target layout's alignment, dimensions, spacing, and shapes. See `ChatLoadingSkeleton` for the reference pattern.
- **Reserve spinners for simple, inline loading states.** `VLoadingIndicator` and `VBusyIndicator` are appropriate only for small, contained actions where the final content shape is unknown or trivial — button loading states, toolbar actions, single-value refreshes. If the loading region occupies more than ~one line of content or will render a repeating/structured layout, use a skeleton instead.
- **Match skeleton anatomy to the real content.** A skeleton should have the same number of visual "rows" or blocks, the same horizontal alignment (leading text, trailing metadata), and similar height proportions as the loaded state. Avoid generic gray rectangles that don't correspond to any real element — they look lazy and don't help the user anticipate the layout.
- **Transition gracefully from skeleton to content.** Swap skeletons for real content without jarring jumps. Prefer a short crossfade (`.transition(.opacity)` with `VAnimation.fast`) over an abrupt replacement. Never show a spinner *and* a skeleton simultaneously.

### Platform-Specific

- **Asynchronous loading.** Load data (network responses, file contents, images) asynchronously off the main thread. Show loading states while data is in flight. Never block the main thread waiting for data.
- **Image loading must be async.** Use `AsyncImage` (built-in) or a library like Kingfisher for image loading. Never decode or resize images synchronously on the main thread — this is a common source of scroll jank in image-heavy views.
- **(macOS) `NSImage` is NOT thread-safe.** Prefer thread-safe CoreGraphics/ImageIO APIs (`CGImageSource`, `CGContext`, `CGImageDestination`) for image processing off the main thread. See:
  - [Apple — NSImage](https://developer.apple.com/documentation/appkit/nsimage) (thread safety limitations)
  - [Apple — CGImageSource](https://developer.apple.com/documentation/imageio/cgimagesource) (thread-safe image loading)
  - [Apple — CGImageDestination](https://developer.apple.com/documentation/imageio/cgimagedestination) (thread-safe JPEG/PNG encoding)
- **Profile before optimizing, but follow known patterns.** Use Instruments to validate — specifically Time Profiler for main-thread spikes, Core Animation instrument for frame drops, and Allocations for memory. Launch Instruments directly from `/Applications/Instruments.app` or via `xcrun instruments`. However, the patterns above are established project standards — follow them proactively rather than waiting for a performance regression.
- **(macOS only) Background timers: gate on display state and use long polling intervals.** Set background polling intervals to at least 300 s (5 min). Before running expensive evaluation, call `CGDisplayIsAsleep(CGMainDisplayID())` and skip if the display is off. Do **not** use `NSApplication.didBecomeActiveNotification` as an activity gate for LSUIElement / accessory-mode apps — this notification never fires when the app has no dock icon, permanently disabling the feature after first use.
- **AVAudio teardown order.** Tear down AVAudio resources in the order `stop` → `removeTap`, plus `recognitionRequest?.endAudio()` when using `SFSpeechRecognizer`. Matches [Apple's SpokenWord sample](https://developer.apple.com/documentation/speech/recognizing-speech-in-live-audio). Always call `removeTap(onBus:)` — even when the engine is already stopped — to prevent `NSInternalInconsistencyException` on the next `installTap`. Do **not** call `audioEngine.reset()` as part of teardown; `reset()` is intended for configuration-change recovery (see next entry), not session cleanup, and calling it on every stop can mask or introduce bugs.
- **AVAudio route-change resilience (reused engines).** When an `AVAudioEngine` is reused across recording sessions, the `AVAudioInputNode` caches its hardware format — so a Bluetooth / USB / AirPods-mode switch between sessions can cause `installTap` to raise a format-mismatch `NSException`. Before re-installing the tap, run `stop → removeTap → reset → re-query outputFormat(forBus:) → installTap(format: …) → start`. The `reset()` forces the node to discard its cached format and re-read the hardware. See `clients/macos/vellum-assistant/Features/Voice/AudioEngineController.swift` (`installTapAndStartImpl`) for the canonical implementation.
- **AVAudioEngine as a reference-typed `@State` value.** Never write `@State private var engine = AVAudioEngine()` directly in a SwiftUI `View`. `@State`'s default expression is re-evaluated on every struct re-init, so the `AVAudioEngine()` allocation fires on every render; SwiftUI keeps only the first one, but each discarded engine still deinitialises (pause / stop CoreAudio resources). Under rapid re-renders this saturates the main thread via ARC churn and CoreAudio side effects, manifesting as an app freeze. Use `@StateObject` with a tiny `ObservableObject` holder (whose autoclosure init fires once per view lifetime), or keep the engine on a controller/service class instead of the view. The same concern applies to any reference type with a non-trivial initialiser (CoreAudio, CoreLocation, WKWebView, long-running tasks).
- **Preserve sidebar↔content animation pairing in `MainWindowView`.** The sidebar and content container in `coreLayout` must both carry `.animation(VAnimation.panel, value: sidebarExpanded)` so they transition in sync when the sidebar collapses or expands. Removing the modifier from either side causes the other to snap instantly, producing a jarring layout jump. This has regressed before — when refactoring `MainWindowView` layout, verify that both the sidebar column and `chatContentView` retain their `sidebarExpanded` animation modifiers.

---

## Scroll and Layout Stability

> The old mode-based scroll state machine (ScrollCoordinator, ScrollMode enum with initialLoad/followingBottom/freeBrowsing/programmaticScroll/stabilizing, recovery windows, stabilization, auto-follow) has been completely removed. The current system uses inverted scroll via a `FlippedModifier` — a flat coordinator with no modal state.

### Architecture: Inverted Scroll via FlippedModifier

> **Canonical reference:** See [`clients/macos/SCROLL_STRATEGY.md`](macos/SCROLL_STRATEGY.md) for the full scroll behavior specification, design decisions, and restoration guide. If scroll behavior breaks, use that document as the source of truth.

The scroll system uses an inverted ScrollView (rotate 180 degrees + mirror horizontally via `FlippedModifier`). The ScrollView gets `.flipped()`, and each row inside also gets `.flipped()` — the double-flip means content appears right-side-up, but the scroll coordinate system is inverted: offset 0 = visual bottom (latest messages).

`MessageListScrollState` (`Features/Chat/MessageListScrollState.swift`) is a lightweight `@Observable @MainActor` class owned by `MessageListView` via `@State`. It tracks CTA visibility and inverted distance metrics — not scroll modes.

**Threads open at bottom naturally.** The inverted ScrollView starts at coordinate top (visual bottom = latest messages) without any `.defaultScrollAnchor`. On conversation switch, `.id(conversationId)` recreates the ScrollView and it naturally opens at visual bottom.

**No scroll-to-bottom on send.** In the inverted ScrollView, new content appears at coordinate top (visual bottom) where the viewport already sits. No imperative scroll calls needed — the viewport stays put naturally.

**No auto-follow during streaming.** The viewport does NOT track new content as the assistant generates tokens. The user message stays visible at the top; assistant content grows below it off-screen.

**"Scroll to latest" CTA.** Appears when `distanceFromBottom > 400`. In inverted scroll, `distanceFromBottom = lastContentOffsetY` (offset 0 = visual bottom). Tapping calls `scrollState.dismissScrollToLatest()` + `scrollPosition = ScrollPosition(edge: .top)` inside `withAnimation(VAnimation.spring)`. Note: `.top` = visual bottom in inverted scroll.

**Thinking placeholder row.** `TranscriptProjector` appends a synthetic placeholder assistant row when `shouldShowThinkingIndicator` is true. This renders the thinking indicator inside the same ForEach row that later holds the real assistant message. Eliminates layout jump on transition. Uses a stable deterministic UUID.

**Pagination.** Rising-edge sentinel detection with 500ms cooldown using `distanceFromTop` (distance to oldest messages = `scrollContentHeight - lastContentOffsetY - scrollContainerHeight`). The `isPaginationInFlight` flag gates the pagination sentinel to prevent stacking concurrent pagination loads.

**Deep-link anchor.** One-shot scroll-to-ID via `ScrollPosition` value replacement. Uses `.center` anchor which is view-relative and works unchanged in inverted scroll.

### Scroll Event Detection

- **User scroll detection:** Use `.onScrollPhaseChange` (macOS 15+) to detect user-initiated scroll phases (`.interacting`, `.decelerating`, `.idle`). This replaces legacy AppKit `NSEvent` scroll-wheel monitors.
- **Distance-from-bottom tracking:** `MessageListScrollObserver` (`NSViewRepresentable`) observes scroll geometry via AppKit `NSView.boundsDidChangeNotification` and `NSView.frameDidChangeNotification`. Computes `distanceFromBottom` for CTA visibility (threshold: 400pt). Do not use `ScrollPosition.viewID` for bottom detection — `viewID` becomes `nil` on user-initiated scroll, making it unreliable for continuous tracking.

### Upstream Observation Fixes

Three fixes outside the scroll subsystem prevent observation feedback loops that drive excessive body re-evaluation:

- **Pagination cooldown.** The pagination sentinel enforces a 500ms cooldown between completions via `lastPaginationCompletedAt` on `MessageListScrollState`. This prevents a feedback loop where scroll triggers pagination, `displayedMessageCount` changes cause body re-evaluation, content/geometry changes fire the sentinel again, and pagination re-enters.

- **Body-level circuit breaker.** When `isThrottled` is true (more than 100 body evaluations in 2 seconds), `derivedState` returns a cached `TranscriptRenderModel` instead of recomputing O(n) derived properties. This makes body re-evaluation cheap during any loop regardless of its source — scroll state changes, pagination, or parent cascade.

- **AssistantActivitySnapshot equality.** `AssistantActivitySnapshot` captures only structural properties (`messageId`, `toolCallCount`, `completedToolCallCount`, `surfaceCount`, `isStreaming`) — not per-token text content. This prevents per-token mutations from cascading into `MessageListBody` re-evaluation.

### Rules

- **Route all scroll reactions through dedicated methods.** Do not add inline `onChange` handlers that call `scrollTo` directly in `MessageListView`. Instead, add a new method on the scroll state or behavior extension and call it from the view. This keeps scroll logic centralized and testable.
- **Use an in-flight guard to prevent stacking concurrent pagination loads.** The `isPaginationInFlight` flag on `MessageListScrollState` gates the pagination sentinel. Without it, rapid scroll-to-top can enqueue multiple concurrent loads before `isLoadingMoreMessages` is set by the async response, duplicating content and corrupting the history cursor.
<details>
<summary><strong>Layout timing, scroll forwarding, and .scrollPosition caveats</strong></summary>

- **Allow a layout settle delay before restoring scroll position.** After inserting new messages (pagination prepend), wait at least **32 ms** before calling `scrollTo(anchor)` so SwiftUI can finish its layout pass. If any inserted content performs an animated height change (e.g., `InlineVideoEmbedCard` at 0.25 s), increase the delay to at least the animation duration (100 ms minimum) — restoring scroll mid-animation lands at the wrong position.
- **Forward scroll/wheel events from gesture-capturing subviews.** `WKWebView` (and other `NSResponder` subclasses that capture scroll events) swallow all scroll-wheel input, preventing the enclosing `ScrollView` from scrolling. Subclass the view and override `scrollWheel(_:)` to forward the event to `nextResponder` instead of consuming it.
- **`ScrollPosition` is the project standard for programmatic scroll tracking.** The message list uses `@State private var scrollPosition = ScrollPosition()` with `.scrollPosition($scrollPosition)` on the ScrollView. Do not reintroduce `ScrollViewReader` — it was removed in favor of `ScrollPosition`.

</details>

---

## Native SwiftUI over Custom AppKit

Prefer built-in SwiftUI primitives over custom `NSViewRepresentable` / AppKit wrappers. Custom AppKit text stacks (NSScrollView + NSClipView + NSTextView) have caused scroll-offset drift bugs that are hard to reproduce and diagnose.

<details>
<summary><strong>SwiftUI vs AppKit reference table</strong></summary>

| Need | Use this | Not this |
|------|----------|----------|
| Multi-line text input (short/medium) | `TextField(axis: .vertical)` + `.lineLimit(1...N)`. Design-system alternative: `VTextEditor` (wraps `NSTextView` via `NSViewRepresentable` on macOS) when Return must insert a newline at the caret and/or a pixel-aligned placeholder overlay is required — [`TextField(axis:)`](https://developer.apple.com/documentation/swiftui/textfield/init(_:text:axis:)-93khd) fires `.onSubmit` on Return and does not insert `\n` | Custom `NSTextView` in `NSScrollView` for ad-hoc call sites |
| Multi-line text input (scrollable) | `TextField(axis: .vertical)` inside `ScrollView` with `.onGeometryChange` height measurement. Fall back to `GeometryReader` in `.background()` if needed | Custom AppKit `NSScrollView` + `NSClipView` + `NSTextView` stack |
| Chat composer (arbitrary-length input) | Custom `NSTextView` via `NSViewRepresentable` (see `ComposerTextView` + `ComposerTextEditor`). `TextField(axis: .vertical)` has [O(n) performance degradation](https://justdoswift.substack.com/p/choosing-a-text-editor-in-swiftui) in `SelectionOverlay.updateNSView` with large text — Apple's own apps use [NSTextView](https://developer.apple.com/documentation/appkit/nstextview) for composers | `TextField(axis: .vertical)` for inputs that accept arbitrary-length paste |
| Long-form text editing | `TextEditor` (acceptable for editor-like surfaces where the user expects a full text-editing experience, e.g., contact notes, skill editing, tool permission tester). Editable code views use `HighlightedTextView` with `CodeTextView` (`NSViewRepresentable`). Read-only code views use `VCodeView` (design system), which wraps a non-editable `NSTextView` for native text selection and copy | Custom AppKit `NSScrollView` + `NSClipView` + `NSTextView` stack |
| Vertical centering in text field | Native `TextField` behavior | Custom `NSClipView` subclass |
| Auto-growing height | `ScrollView` + `.onGeometryChange` on inner content + `.frame(height: clamp(measured, min, max))`. Fall back to `GeometryReader` in `.background()` if needed | Custom AppKit height sync. Note: `.lineLimit(1...N)` truncates instead of scrolling on macOS when content exceeds N lines — only use it for short-form inputs where truncation is acceptable |
| Return-to-send in chat input | `ComposerTextView.keyDown(with:)` using `ComposerReturnKeyRouting` — handles Return/Shift+Return/Cmd+Return directly in the NSTextView subclass | `.onKeyPress(.return)` (returning `.ignored` doesn't fall back to TextField's newline behavior) |
| Keyboard shortcuts | `.onKeyPress()` modifiers | `keyDown(with:)` / `performKeyEquivalent` overrides |
| Attributed/colored text display | `AttributedString` + `Text` overlay | `layoutManager.addTemporaryAttributes` |
| File drag-drop | `.onDrop(of: [.fileURL])` | `performDragOperation` override |
| Focus management | `@FocusState` | Manual `makeFirstResponder` calls |
| Placeholder text | `TextField("placeholder", ...)` | Custom `draw()` override |

</details>

**When AppKit bridges are still needed** (keep them minimal — only AppKit-specific logic, no business logic or layout):
- Chat composer text input (`ComposerTextView` + `ComposerTextEditor`) — justified by `TextField(axis: .vertical)` [O(n) performance issue](https://justdoswift.substack.com/p/choosing-a-text-editor-in-swiftui)
- Design-system multi-line input (`VTextEditor` → `VTextEditorNSTextView` on macOS) — justified by [`TextField(axis:)`](https://developer.apple.com/documentation/swiftui/textfield/init(_:text:axis:)-93khd) firing `.onSubmit` on Return instead of inserting `\n`, and by [`TextEditor`](https://developer.apple.com/documentation/swiftui/texteditor) not exposing [`NSTextContainer.lineFragmentPadding`](https://developer.apple.com/documentation/appkit/nstextcontainer/linefragmentpadding) / [`NSTextView.textContainerInset`](https://developer.apple.com/documentation/appkit/nstextview/textcontainerinset) so a sibling placeholder overlay cannot be pixel-aligned with the caret across macOS versions
- Intercepting `Cmd+V` for image paste detection (pasteboard inspection not available in SwiftUI)
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

### Terminology: Avoid "Daemon" in Client Code
In client-facing code (variable names, comments, UI strings), prefer **"assistant"** over **"daemon"**. The daemon is an implementation detail of the backend; client code should use user-facing terminology. For example, use `assistantLoadingTimedOut` instead of `daemonLoadingTimedOut`. Existing usages of "daemon" in variable names should be updated opportunistically when touching the surrounding code.

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
| `GeometryReader` as layout container | Expands to fill available space, breaking intrinsic sizing | Use `.onGeometryChange(for:body:action:)` for measurement (macOS 14+). Fall back to `GeometryReader` in `.background()` only if `.onGeometryChange` is insufficient for the use case |
| View in flexible container without size constraint | View expands to fill parent (e.g., ZStack) | Add `.fixedSize(horizontal: false, vertical: true)` to hug content |
| Mutable array in `DispatchGroup` callbacks | Race condition — callbacks may run on different threads | Wrap each append in `DispatchQueue.main.async`; for new code, prefer actor isolation or `@Sendable` closures |
| Duplicated send/action logic across code paths | Paths drift out of sync (e.g., AppKit bridge vs SwiftUI handler) | Extract shared logic into a single function both paths call |
| `.scrollPosition(id:)` with unmanaged binding | Nil binding fights SwiftUI's internal tracking, crashes on re-layout | Use `ScrollPosition()` (no idType constraint) for programmatic scrolling; use `MessageListScrollObserver` for distance-from-bottom tracking |
| Strong closure capture on window | Retain cycle if window outlives view | Use `[weak coordinator]` or clear in `dismantleNSView` |
| Mutating the view's content model in `dismantleNSView` (e.g. `textStorage.setAttributedString(_:)`, `layer.contents = nil`) | Posts AppKit notifications that synchronously cascade through layout, selection, and accessibility on the main thread. Batched teardown (e.g. every cell in a `LazyVStack` when the container's `.id(…)` changes) multiplies the per-view cost into a multi-second hang | Only clean up external references the OS cannot reach (observers, subscriptions, undo-manager targets, script handlers). ARC releases the view's own content model. Ref: [`NSViewRepresentable.dismantleNSView`](https://developer.apple.com/documentation/swiftui/nsviewrepresentable/dismantlensview(_:coordinator:)) |
| `@Observable` dictionary as per-entity store | Any key mutation invalidates all views reading the dictionary | Use per-entity `@Observable` wrapper objects; mutate their properties instead of the dictionary |
| GeometryReader on ScrollView `.background` measuring parent frame | Measures the ScrollView's proposed size (parent frame), not content intrinsic height — creates feedback loop where state derived from the measurement drives the frame that's being measured | Place GeometryReader on the *inner content* (inside the ScrollView), and reset all derived state (`contentHeight`, `isExpanded`) atomically when content clears |
| `.foregroundColor(VColor.xxx)` | Deprecated since macOS 12; fully removed from the codebase — do not reintroduce | Use `.foregroundStyle(VColor.xxx)` — drop-in replacement for `Color` values |
| Inherited `.animation()` causing layout interpolation during view switches | A parent's `.animation()` modifier applies to all descendants, including subtrees that should switch instantly (e.g., tab/panel changes) | Apply `.animation(nil, value: switchValue)` on the subtree that should not animate. This overrides the inherited animation for that specific value change while preserving sibling animations driven by other values. |
| `GeometryReader` in `.background()` for measurement | Requires a `Color.clear` wrapper, fires only via manual `.onAppear`/`.onChange`, and is easy to wire incorrectly | Use `.onGeometryChange(for:body:action:)` with the **single-value action overload** (macOS 14+). Fires on initial layout and on changes automatically — no wrapper view needed. Extract the minimal type (e.g., `Bool`, `CGFloat`) in the `body` closure so the action only fires when the derived value changes. |
| `Timer.publish` / `Timer.scheduledTimer` for UI updates | Timer continues firing when the view is off-screen, wastes energy, and requires manual lifecycle management (invalidate, cancellable storage) | Prefer `TimelineView(.periodic(from: .now, by: interval))` for fixed-rate displays or `TimelineView(.animation)` for frame-rate animations — it auto-pauses off-screen and requires no manual teardown. **Exception (macOS):** `TimelineView(.periodic)` can silently stop firing during idle or heavy layout passes, causing progress indicators to freeze. For views that *must* tick reliably (e.g., elapsed-time counters, processing-dots animations), use `Timer.publish(every:on:.main,in:.common).autoconnect()` and cancel the subscription `.onDisappear` to avoid energy waste. |
| `DispatchQueue.main.sync` from `@MainActor` or main thread | Deadlocks. Ref: [Apple — DispatchQueue.sync](https://developer.apple.com/documentation/dispatch/dispatchqueue/sync(execute:)-3gef0) | Use `Thread.isMainThread` guard, or `await MainActor.run {}` from async contexts. Prefer thread-safe APIs that don't need the main thread. |
| CPU-bound work inside `@MainActor` type without offloading | Blocks UI (JSON decode, image resize, compression). Ref: [WWDC25 — Embracing Swift concurrency](https://developer.apple.com/videos/play/wwdc2025/268/) | Offload the expensive call via `Task.detached`. Keep the type on `@MainActor`. See § "@MainActor Isolation Boundaries". |
| N independent observers each scheduling heavy `@MainActor` work from a single event | Responses arrive near-simultaneously and saturate the main actor (e.g., reconnection triggers N history reloads). Ref: [`Task.yield()`](https://developer.apple.com/documentation/swift/task/yield()) | Serialize through a queue with `Task.yield()` between iterations. See § "@MainActor Isolation Boundaries". |
| Unguarded `NSLayoutManager.ensureLayout(for:)` in `NSViewRepresentable.sizeThatFits` inside `LazyVStack`/`List` cells | SwiftUI calls `sizeThatFits` on every visible cell on every layout pass; `ensureLayout` is O(glyphs) on the main thread. Caches keyed only on text content (not width) silently skip on same-text-new-width queries, running layout again. | Cache last measurement on `(textStorage.length, proposalWidth)` at minimum; use `NSAttributedString.isEqual(_:)` when attributes matter. Invalidate at every text-storage mutation site. When line wrapping is off and line height is pinned, use `lineCount * lineHeight + insets` directly. See § "View Bodies and Rendering". |
| Default `NSLayoutManager.allowsNonContiguousLayout` (`false`) on TextKit 1 stacks in `NSViewRepresentable` | The first time the `NSTextView` is attached to its hosting view, AppKit's `setNeedsDisplayInRect:` asks the layout manager for a glyph range, which forces full-document layout from character 0 on the main thread. Multi-second hangs on large documents. | Set `layoutManager.allowsNonContiguousLayout = true` when constructing the TextKit 1 stack. **Exception:** representables that measure height via a separate TextKit stack which always fully lays out every glyph (e.g. `VSelectableTextView`, used for streaming chat text) must keep `allowsNonContiguousLayout = false` on the render stack — otherwise the render lags the measured frame during streaming, producing a visible gap and then overlap with the next sibling. See § "View Bodies and Rendering" and `clients/shared/DesignSystem/Components/Display/SelectableTextView.swift:180-205`. |

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
3. **Fragile with our architecture.** Many views depend on `AuthManager`, `GatewayConnectionManager`, or other services that require a running backend. Previews that instantiate these may not render without a live daemon connection.
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
- **Clearing persisted state is a two-sided contract.** When shared code (e.g. `AuthManager`) clears persisted identity or connection state on one transition, the platform shell must have a reconciler that restores the equivalent state on the inverse transition. Wire platform-specific restoration through injected hooks on the shared component (e.g. `AuthManager.postAuthenticationHook`) rather than reaching into shared code with direct `UserDefaults` writes or lockfile mutations. This keeps shared code agnostic of caller-specific persistence and makes the restore path explicit and unit-testable.

---

## Testing and Quality
- Add or update tests when behavior changes; favor the testing patterns already used in that client.
- Keep builds and linting clean; run relevant tests when feasible.

---

## Daemon Event Recovery (Turn State)

The daemon communicates turn lifecycle through SSE events on a single stream with no replay or delivery guarantee. Any event can be lost during stream gaps, reconnects, or internal filtering. **Every turn-state phase that disables an existing recovery mechanism must have its own equivalent recovery path.**

- **`assistantActivityState("idle")` is the authoritative turn-completion signal.** When the daemon reports idle, the handler must clear all turn-progress indicators (`isSending`, `isThinking`, `isCompacting`, tool call spinners) — not just one flag.
- **Watchdog parity.** If a new activity phase (e.g., "thinking") disables an existing watchdog (e.g., setting `isSending = false` to prevent the 60s watchdog from killing extended thinking), add an equivalent watchdog for the new phase.
- **Preserve `currentAssistantMessageId` for `messageComplete`.** The daemon emits `idle` immediately before `messageComplete` on the same stream. Don't clear `currentAssistantMessageId` in the idle handler — use a short fallback timer that fires only if `messageComplete` never arrives.
- **Cancel fallback timers in all state-reset paths.** Any deferred cleanup task (idle fallback, watchdog) must be cancelled in `handleTransportReconnect`, `startMessageLoop` error handler, `populateFromHistory`, and `handleMessageComplete` — anywhere that clears `currentAssistantMessageId` outside the normal idle → messageComplete flow.

---

## Networking: GatewayHTTPClient

All HTTP API calls go through `GatewayHTTPClient` (a stateless enum with static async methods).

When adding a new HTTP endpoint call:

1. Create or extend a focused protocol (e.g. `ConversationClientProtocol`) describing the operation.
2. Implement it in a struct that calls `GatewayHTTPClient.get/post/delete(path:timeout:)`. Path encoding and `{assistantId}` substitution are handled automatically by `GatewayHTTPClient.buildRequest()` — do not percent-encode paths manually.
3. Instantiate the struct inline as a private property on the consuming type (e.g. `private let surfaceClient: any SurfaceClientProtocol = SurfaceClient()`).
4. Stateless network client structs and protocols (enums with static methods, request builders) are naturally `nonisolated`. Stateful managers that own mutable state should be `@MainActor`. See § "@MainActor Isolation Boundaries" above.

See `clients/ARCHITECTURE.md` § "GatewayHTTPClient" for the full pattern.

---

## Docs Anti-Drift
- Avoid brittle hardcoded counts, version claims, or roadmap placeholders in client READMEs unless they are generated automatically. Prefer evergreen wording (e.g., "shared package tests" instead of "152 shared package tests").
- When updating documentation, verify claims against the current codebase rather than copying from stale sources.
- **Validate guidance against linked references.** Sections in this document include links to Apple documentation, WWDC sessions, and Swift Evolution proposals. When working in a related area, check the linked references to confirm the guidance is still current. If a reference has been superseded (e.g., a new WWDC session, a revised API, a Swift Evolution proposal that changed behavior), update the guidance and its links accordingly.
- **Platform guidance has a shelf life.** Apple deprecates APIs and changes best practices annually at WWDC. Treat all platform-specific guidance (concurrency patterns, SwiftUI APIs, AppKit thread-safety rules) as potentially stale. When in doubt, check the linked reference — if the link is broken or the content has changed, the guidance needs updating.

---

## Maintenance

- Refresh this guidance after major Apple OS or SwiftUI releases (for example, post-WWDC).
- **When fixing a bug, consider whether the root cause represents a generalizable pitfall.** If an API was misused in a way that compiled but caused runtime crashes, freezes, or subtle misbehavior — and another developer or agent could plausibly make the same mistake — add a rule to the relevant section of this file (or the pitfalls table). This file is the team's collective memory for hard-won lessons; keeping it current prevents repeat bugs.
