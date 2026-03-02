# Clients - Agent Guidance

## Scope and precedence
- Applies to all client code in `clients/` (macOS, iOS, iPadOS, watchOS, tvOS, browser extensions, shared).
- Platform-specific docs (for example `clients/macos/CLAUDE.md`, `clients/ios/README.md`) override or extend this file.
- `AGENTS.md` at repo root still applies; if guidance conflicts, follow the most specific document.

## Research protocol (Apple platform work)
- Verify decisions against current Apple sources (Developer Documentation, HIG, WWDC sessions, Swift Evolution).
- Check deprecations and availability for targeted OS versions before adopting APIs.
- Prefer Apple-recommended patterns for SwiftUI, concurrency, accessibility, privacy, and app lifecycle.
- Note in the PR summary or commit message: `Apple refs checked (YYYY-MM-DD): ...`.
- If guidance is ambiguous, include a short rationale in the PR summary.

## SwiftUI + Apple platform practices (guidance)
- Follow SwiftUI data flow and state ownership; keep state minimal and localized.
- Keep UI work on the main actor; use async/await and structured concurrency when possible.
- Avoid deprecated APIs; use availability checks for multi-platform code.
- Respect HIG defaults for layout, typography, and controls; only customize when user value is clear.
- Accessibility is required: labels for icon-only controls, Dynamic Type support, VoiceOver-friendly order.
- Localize user-facing strings; format dates/units with locale-aware formatters.
- Privacy: request the minimum permissions; never log sensitive user content.

## Performance and resource management
- **View bodies must be lightweight.** Never perform I/O, network calls, or heavy computation inside a SwiftUI view body. Defer work to `task {}`, `onAppear`, or background actors.
- **Lazy containers for large collections.** Use `LazyVStack`, `LazyHStack`, `LazyVGrid` instead of eager equivalents when the item count is unbounded or large.
- **Coalesce high-frequency publishes.** When a Combine publisher or `@Observable` property fires at high frequency (for example per-token streaming), coalesce updates with `throttle`, `debounce`, or a manual coalescing window (100 ms minimum) to avoid render churn. See `PERF_NOTES.md` for real examples.
- **Prefer async/await and structured concurrency.** Use `Task {}` with proper cancellation over raw GCD or unstructured `Task.detached` unless there is a specific reason.
- **Always cancel subscriptions and tasks.** Store `AnyCancellable` tokens and cancel them in `deinit` or `onDisappear`. For `Task {}` started in `onAppear`, cancel in `onDisappear`. For `@StateObject` / `@ObservedObject` view models, cancel in `deinit`.
- **Remove observers and listeners.** Unsubscribe from `NotificationCenter`, KVO, and any custom event systems when the owning object is deallocated or the view disappears. Prefer the `task {}` modifier with implicit cancellation over manual `NotificationCenter.addObserver`.
- **Avoid retain cycles.** Use `[weak self]` in closures stored by long-lived objects. Be especially careful with closures passed to Combine `sink`, `onReceive`, and completion handlers on network calls.
- **Release heavy resources promptly.** Clear large data (base64 payloads, image data, surface HTML) from memory once it is no longer displayed. Do not accumulate unbounded data across a session. See M6 and M8 in `PERF_NOTES.md`.
- **Scope observation narrowly.** Only observe the specific properties a view needs. Prefer granular `@Observable` properties or `withObservationTracking` over observing an entire store that publishes on unrelated changes.
- **Profile before optimizing, but follow known patterns.** Use Instruments (Time Profiler, Allocations, SwiftUI view body counters) to validate. However, the patterns above are established project standards — follow them proactively rather than waiting for a performance regression.
- **Asynchronous loading.** Load data (network responses, file contents, images) asynchronously off the main thread. Show loading states (`VLoadingIndicator`, `VBusyIndicator`) while data is in flight. Never block the main thread waiting for data.

## Non-Apple clients
- Follow platform-specific best practices for the target (for example, Chrome extension guidelines).
- Keep shared client logic in `clients/shared` when it is platform-agnostic.

## Design System (`clients/shared/DesignSystem`)

### Use shared components first
- Before building any new UI element, check `clients/shared/DesignSystem/` for an existing component.
- The design system is organized into layers:
  - **Tokens** — `Tokens/` contains primitive values: `ColorTokens`, `SpacingTokens`, `TypographyTokens`, `RadiusTokens`, `ShadowTokens`, `AnimationTokens`. Always use tokens instead of raw literals.
  - **Core** — `Core/` contains foundational controls: `VButton`, `VIconButton`, `VTextField`, `VTextEditor`, `VToggle`, `VSlider`, `VDropdown`, `VSearchBar`, `VBadge`, `VToast`, `VLoadingIndicator`, `VListRow`, `VDisclosureSection`, `VTab`, etc.
  - **Components** — `Components/` contains composed, higher-level components: `VCard`, `VEmptyState`, `VSplitView`, `VSidePanel`, `VToolbar`, `VTabBar`, `VSegmentedControl`, `VWaveformView`, etc.
  - **Modifiers** — `Modifiers/` contains reusable view modifiers: `CardModifier`, `HoverEffect`, `PanelBackground`, `InlineWidgetCardModifier`.
  - **Gallery** — `Gallery/` is a live preview catalog of all components. Update it when adding new components.
- Use the `V`-prefixed components (for example `VButton`, `VCard`, `VTextField`) rather than rolling custom equivalents.
- Use design tokens (`VColor.*`, `VSpacing.*`, `VRadius.*`, `VTypography.*`, `VShadow.*`) instead of hardcoded values.

### Adding new shared components
- If a needed component does not exist, add it to the appropriate `DesignSystem/` subdirectory (`Core/` for primitives, `Components/` for composed elements, `Modifiers/` for view modifiers).
- Follow existing naming conventions: prefix with `V`, use descriptive names (for example `VProgressBar`, `VAvatar`).
- New components must be reusable and platform-agnostic; do not embed platform-specific code.
- Add a `#Preview` block to the component file and a corresponding section in `Gallery/` so it appears in the component catalog.
- If you create a component inline in a feature and it could be reused elsewhere, extract it into the design system before merging.

### Avoiding duplication
- Do not create one-off UI elements that duplicate existing design system components. Search the `DesignSystem/` directory before building.
- When a feature needs a slight variation of an existing component, extend the component with a new parameter or style rather than forking it.

## Architecture and shared code
- Put cross-platform logic in `clients/shared`.
- Do not introduce platform-specific dependencies into shared targets.
- Prefer dependency injection for platform services to keep logic testable.

## Testing and quality
- Add or update tests when behavior changes; favor the testing patterns already used in that client.
- Keep builds and linting clean; run relevant tests when feasible.

## Maintenance
- Refresh this guidance after major Apple OS or SwiftUI releases (for example, post-WWDC).
