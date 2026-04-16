# Vellum Chat Scroll Strategy

> **Architecture:** Inverted scroll via `FlippedModifier`
> **Reference PRs:** #25828 through #25834 (inverted scroll migration, PRs 1-7)
>
> This document captures the exact scroll behavior and architecture that feels right.
> If scroll behavior breaks due to future changes, use this as the source of truth to restore it.

---

## Design Philosophy

1. **No auto-follow.** The viewport does NOT track streaming content. The newest non-queued user message stays pinned at the top of the active turn while the assistant response grows below it.
2. **Inverted scroll handles latest-edge anchoring; a dedicated spacer handles user-at-top pinning.** The ScrollView is flipped 180 degrees so new content naturally appears at the visual bottom, and the latest-turn section adds a computed spacer below the response so landing at the latest edge keeps the user bubble at the top.
3. **Simple distance-based CTA.** "Scroll to latest" appears when >400pt from bottom. No modes, no hysteresis, no state machine.
4. **Threads open at bottom.** The inverted ScrollView starts at the visual bottom (latest messages) naturally. No `.defaultScrollAnchor` needed.
5. **One container for thinking + assistant.** A synthetic placeholder row in the ForEach holds the thinking indicator. When the real assistant message arrives, it replaces the placeholder in the same container — no layout jump.

---

## The Inverted Scroll Technique

### FlippedModifier

The entire ScrollView and each row inside it are flipped using a `FlippedModifier`:

```swift
struct FlippedModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .rotationEffect(.radians(.pi))                                  // rotate 180°
            .scaleEffect(x: -1, y: 1, anchor: .center)                   // mirror horizontally
    }
}
```

The ScrollView gets `.flipped()`, and each row inside also gets `.flipped()`. The double-flip means the content appears right-side-up to the user, but the scroll coordinate system is inverted: the ScrollView's natural "top" (offset 0) is the visual bottom (latest messages).

### Why This Works

1. **No scroll-to-bottom management.** In a normal ScrollView, new content added at the bottom pushes the viewport up — you need imperative `scrollTo(.bottom)` to follow. In an inverted ScrollView, new content is added at the coordinate "top" (visual bottom), which is where the viewport already sits. The viewport stays put naturally.

2. **No LazyVStack materialization hang.** With a normal bottom-anchored ScrollView, SwiftUI had to materialize all items to compute content height before it could position at the bottom. With inverted scroll, the "top" (visual bottom) is the natural starting position — SwiftUI only materializes visible items.

3. **No multi-stage scroll restore.** The old architecture needed `switchRestoreTask`, `isScrollRestored` opacity fade, and deferred scroll calls to restore position on conversation switch. With inverted scroll, `.id(conversationId)` recreates the ScrollView and it naturally opens at visual bottom (coordinate top).

---

## Architecture Overview

### State: `MessageListScrollState` (flat coordinator)

An `@Observable @MainActor` class with **no modes, no transitions, no recovery**. Just tracks:

- **Geometry:** `scrollContentHeight`, `scrollContainerHeight`, `lastContentOffsetY`, `viewportHeight`
- **Latest-turn pinning:** `pinnedLatestTurnAnchorMessageId`
- **Distance metrics (inverted):**
  - `distanceFromBottom = lastContentOffsetY` (in inverted scroll, offset 0 = visual bottom, so raw offset IS distance from bottom)
  - `distanceFromTop = scrollContentHeight - lastContentOffsetY - scrollContainerHeight` (for pagination — distance from visual top = oldest messages)
- **CTA visibility:** `showScrollToLatest` (driven by `distanceFromBottom > 400`)
- **Pagination:** `wasPaginationTriggerInRange`, `lastPaginationCompletedAt` (rising-edge + 500ms cooldown), uses `distanceFromTop` threshold
- **Deep-link anchor:** `anchorSetTime`, `anchorTimeoutTask`
- **Scroll indicators:** `scrollIndicatorsHidden` (briefly hidden on conversation switch)

**What does NOT exist:** ScrollMode enum, mode transitions, auto-follow, recovery windows, stabilization, deferred bottom pins, circuit breaker, scroll closures (scrollTo/scrollToEdge/cancelScrollAnimation), configureScrollCallbacks, restoreScrollToBottom, ScrollCoordinator, switchRestoreTask, pendingSendScrollMessageId, hasSendScrollFired, isScrollRestored, per-row minHeight wrappers, turnMinHeight, containerHeight.

### View: `MessageListView`

```
ScrollView {
    HStack { Spacer + scrollViewContent + Spacer }
}
.flipped()                                              // Inverted scroll
.scrollPosition($scrollPosition)
.scrollIndicators(scrollState.scrollIndicatorsHidden ? .hidden : .automatic)
.id(conversationId)                                     // On ScrollView itself
.overlay(alignment: .bottom) { ScrollToLatestOverlayView }
```

No `.defaultScrollAnchor`. No `.onScrollPhaseChange`. No `.environment(\.suppressAutoScroll)`. No ScrollCoordinator.

### Content: `MessageListContentView`

Older history still renders through the existing `displayedItems.reversed()` path, with each direct child `.flipped()` to undo the ScrollView flip.

When `pinnedLatestTurnAnchorMessageId` is set, the newest turn is carved out into a dedicated `PinnedLatestTurnSection`:

- latest-edge sentinel
- computed spacer
- response cluster (assistant rows, placeholder, latest-edge indicators, orphan subagents, queued marker content)
- anchor user row

The section is flipped as a single unit, so the visual order becomes:

- anchor user row
- assistant response cluster
- spacer

`LatestTurnSpacerCalculator` computes:

```swift
max(0, viewportHeight - anchorHeight - responseHeight)
```

The response cluster is measured after the single anchor-to-response gap is applied, so the formula stays exact without reviving `turnMinHeight` or any height estimates.

---

## The Send Flow

With inverted scroll, new content naturally appears at the visual bottom. No imperative scroll-to-bottom is needed.

### Step 1: Message appended
`MessageSendCoordinator` appends the user message to `messages` and calls `flushCoalescedPublish()`. Then sets `isSending = true`.

### Step 2: Content appears at bottom
The inverted ScrollView adds new content at coordinate top (visual bottom) naturally. The viewport stays put — no scroll management required.

### Step 3: Latest-turn spacer keeps the user at top
On a genuine user send, `pinnedLatestTurnAnchorMessageId` is updated to that newest non-queued user message. The dedicated latest-turn section then measures the anchor row and response cluster and fills the remaining viewport with a spacer below the response. As assistant content grows, the spacer shrinks to zero.

---

## Thinking Placeholder (Prevents Layout Jump)

`TranscriptProjector` appends a synthetic row when `shouldShowThinkingIndicator` is true:

```swift
private static let thinkingPlaceholderId = UUID(uuidString: "00000000-0000-0000-0000-FFFFFFFFFFFF")!

if shouldShowThinkingIndicator {
    let placeholderMessage = ChatMessage(id: Self.thinkingPlaceholderId, role: .assistant, text: "")
    let placeholder = TranscriptRowModel(..., isLatestAssistant: true, isThinkingPlaceholder: true)
    rows.append(placeholder)
}
```

**Why stable UUID:** ForEach uses `row.id` (which is `message.id`) for view identity. A new UUID every frame would cause layout thrashing.

**Why a placeholder:** Before this, the thinking indicator was a standalone section outside the ForEach. When the assistant message appeared inside the ForEach, SwiftUI destroyed one container and created another — different spacing, different chrome, different content height. The swap caused a visible layout shift. With the placeholder, the thinking indicator renders inside the same ForEach row that will later hold the assistant message.

---

## Scroll-to-Latest CTA

In inverted scroll, `distanceFromBottom` is simply `lastContentOffsetY` (offset 0 = visual bottom).

```swift
// In MessageListScrollState:
func updateScrollToLatest() {
    let shouldShow = distanceFromBottom > 400
    if showScrollToLatest != shouldShow {
        showScrollToLatest = shouldShow
    }
}

func dismissScrollToLatest() {
    showScrollToLatest = false
}
```

Button tap:
```swift
withAnimation(VAnimation.spring) {
    scrollState.dismissScrollToLatest()
    onScrollToBottom()  // -> scrollPosition = ScrollPosition(edge: .top)  // .top = visual bottom in inverted scroll
}
```

**Why `ScrollPosition(edge: .top)` for visual bottom:** In the inverted ScrollView, coordinate top IS visual bottom. So scrolling to `.top` takes you to the latest messages.

---

## Pagination

Pagination triggers when the user scrolls toward older messages (visual top = coordinate bottom in inverted scroll).

```swift
// distanceFromTop = scrollContentHeight - lastContentOffsetY - scrollContainerHeight
let isNearTop = distanceFromTop < paginationThreshold
```

Uses the same rising-edge detection with 500ms cooldown as before — just the distance metric changed from `distanceFromBottom` (old) to `distanceFromTop` (inverted).

---

## Deep-Link Anchors

Deep-link scroll uses `.center` anchor for scroll-to-ID via `ScrollPosition` value replacement. The `.center` anchor is view-relative and works unchanged in inverted scroll — no special handling needed.

---

## Conversation Switching

```swift
.id(conversationId)    // Destroys + recreates ScrollView — on the ScrollView itself
```

`handleAppear()` detects the switch via `scrollState.currentConversationId` comparison, calls `handleConversationSwitched()` which:
1. Cancels queued geometry callbacks (`ScrollGeometryUpdateDispatcher.shared.cancel`)
2. Resets all scroll state (`scrollState.reset(for:)`)
3. Seeds `lastMessageId`
4. Does NOT write to `scrollPosition` — inverted scroll naturally opens at visual bottom

**No explicit scroll on switch.** The `.id()` recreation is sufficient. Inverted scroll starts at coordinate top = visual bottom naturally.

---

## User Message Collapse

Long user messages collapse at 150pt. The collapse decision is driven **purely** by a deterministic estimate of text + per-attachment heights, computed from the model:

```swift
let isCollapsible = estimatedContentExceedsCollapseThreshold
let needsCollapse = isCollapsible && !isUserMessageExpanded
```

`estimatedContentExceedsCollapseThreshold` combines `NSString.boundingRect` on the message text with conservative per-attachment heights (single image ~200pt, grid tiles 120pt, videos/inline previews ~200pt, audio ~80pt, file chips ~40pt) that mirror the renderers in `ChatBubbleAttachmentContent.swift`.

**Do not wire `onGeometryChange` (or any layout observation) into the collapsibility state.** `.frame(height: 150)` is a `_FrameLayout` that hard-proposes 150pt to its child; observing the child's height and feeding it back into state creates a feedback loop that flips `isCollapsible` to false on the first toggle, removing the "Show less" button and the frame clamp together. See [`onGeometryChange` docs](https://developer.apple.com/documentation/swiftui/view/ongeometrychange(for:of:action:)) for the general guidance that geometry observations should not drive state that changes the observed layout.

Collapsed messages have:
- Gradient fade overlay (transparent -> `VColor.surfaceLift`)
- "Show more" button using `VButton(style: .ghost, size: .compact, tintColor: .contentTertiary)`, left-aligned
- Button is inside the bubble container (rounded corners, surfaceLift background)

---

## What NOT To Add Back

These were removed for a reason. Do not re-introduce:

| Removed | Why |
|---------|-----|
| `ScrollMode` enum / state machine | Caused complex mode transitions, race conditions, and recovery loops |
| Auto-follow during streaming | Fought with user scroll, caused flickering and snap-backs |
| `ScrollCoordinator` | Added indirection without value — all decisions are simpler inline |
| `restoreScrollToBottom()` | Recovery-based scrolling was unreliable and caused jarring jumps |
| `configureScrollCallbacks()` | Scroll closures on state object; direct `ScrollPosition` access is simpler |
| `suppressAutoScroll` environment | Was for suppressing auto-follow which no longer exists |
| Recovery windows / deadlines | Complex timer-based scroll correction; the flat model doesn't need it |
| Stabilization / circuit breaker | Protected against layout storms from mode transitions; no modes = no storms |
| `isAtBottom` hysteresis | Asymmetric thresholds to prevent oscillation; distance CTA is simpler |
| `switchRestoreTask` | Multi-stage scroll restore on conversation switch; inverted scroll opens at bottom naturally |
| `pendingSendScrollMessageId` | Tracked which message to scroll to after send; inverted scroll needs no scroll-to-bottom |
| `hasSendScrollFired` | Gated the send-scroll-to-bottom call; no send-scroll exists in inverted model |
| `isScrollRestored` / opacity fade | Hid content until scroll position was restored; inverted scroll positions instantly |
| `.defaultScrollAnchor(.bottom)` | Was needed to start at bottom in normal scroll; inverted scroll starts at visual bottom naturally |
| `turnMinHeight` / minHeight wrapper | Filled viewport below user message on send; inverted scroll keeps user message visible without it |
| `containerHeight` property | Drove the minHeight calculation; removed along with minHeight wrapper |

---

## Files That Own Scroll Behavior

| File | Responsibility |
|------|---------------|
| `MessageListTypes.swift` | `FlippedModifier` — the rotation + mirror transform for inverted scroll |
| `MessageListScrollState.swift` | Flat coordinator — geometry, CTA, pagination, anchor state, inverted distance metrics |
| `MessageListView.swift` | ScrollView setup — `.flipped()`, position binding, indicators, overlay |
| `MessageListView+ScrollHandling.swift` | Geometry handler — updates state, triggers pagination using `distanceFromTop` |
| `MessageListView+Lifecycle.swift` | Send detection, conversation switch, anchor resolution |
| `MessageListContentView.swift` | History rendering, pinned latest-turn section, spacer math, thinking placeholder |
| `MessageListHelperViews.swift` | ScrollToLatestOverlayView — CTA button |
| `TranscriptProjector.swift` | Thinking placeholder row injection |
| `TranscriptRenderModel.swift` | `isThinkingPlaceholder` flag on row model |
| `ChatBubble.swift` | User message collapse (instant estimate + gradient fade) |
