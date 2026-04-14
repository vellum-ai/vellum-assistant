# Vellum Chat Scroll Strategy

> **Reference commit:** `2dcb606af` (merged 2026-04-13)
> **PR:** #25206 — "refactor: remove scroll state machine — replace with flat coordinator"
>
> This document captures the exact scroll behavior and architecture that feels right.
> If scroll behavior breaks due to future changes, use this as the source of truth to restore it.

---

## Design Philosophy

1. **No auto-follow.** The viewport does NOT track streaming content. The user message stays pinned at the top while the assistant response grows below it.
2. **Scroll to bottom on send.** When the user sends a message, we smoothly scroll to the bottom. The assistant's minHeight container fills the viewport, naturally pinning the user message to the top.
3. **Simple distance-based CTA.** "Scroll to latest" appears when >400pt from bottom. No modes, no hysteresis, no state machine.
4. **Threads open at bottom.** `.defaultScrollAnchor(.bottom, for: .initialOffset)` — conversations start at the latest messages.
5. **One container for thinking + assistant.** A synthetic placeholder row in the ForEach holds the thinking indicator. When the real assistant message arrives, it replaces the placeholder in the same container — no layout jump.

---

## Architecture Overview

### State: `MessageListScrollState` (flat coordinator)

An `@Observable @MainActor` class with **no modes, no transitions, no recovery**. Just tracks:

- **Geometry:** `scrollContentHeight`, `scrollContainerHeight`, `lastContentOffsetY`, `viewportHeight`
- **CTA visibility:** `showScrollToLatest` (driven by `distanceFromBottom > 400`)
- **Send scroll:** `pendingSendScrollMessageId: UUID?` — set when user sends, cleared after scroll fires
- **Pagination:** `wasPaginationTriggerInRange`, `lastPaginationCompletedAt` (rising-edge + 500ms cooldown)
- **Deep-link anchor:** `anchorSetTime`, `anchorTimeoutTask`
- **Scroll indicators:** `scrollIndicatorsHidden` (briefly hidden on conversation switch)

**What does NOT exist:** ScrollMode enum, mode transitions, auto-follow, recovery windows, stabilization, deferred bottom pins, circuit breaker, scroll closures (scrollTo/scrollToEdge/cancelScrollAnimation), configureScrollCallbacks, restoreScrollToBottom, ScrollCoordinator.

### View: `MessageListView`

```
ScrollView {
    HStack { Spacer + scrollViewContent + Spacer }
}
.defaultScrollAnchor(.top, for: .initialOffset)
.scrollPosition($scrollPosition)
.scrollIndicators(scrollState.scrollIndicatorsHidden ? .hidden : .automatic)
.id(conversationId)
.overlay(alignment: .bottom) { ScrollToLatestOverlayView }
```

No `.onScrollPhaseChange`. No `.environment(\.suppressAutoScroll)`. No ScrollCoordinator.

### Content: `MessageListContentView`

ForEach renders both:
- **Normal message cells** via `MessageCellView`
- **Thinking placeholder** via `row.isThinkingPlaceholder` (synthetic row from TranscriptProjector)

Both share the same `.if(row.isLatestAssistant ...)` minHeight wrapper — one container, no swap.

---

## The Send-Scroll Flow (Critical Path)

This is the most important interaction. When the user sends a message:

### Step 1: Message appended
`MessageSendCoordinator` appends the user message to `messages` and calls `flushCoalescedPublish()`. Then sets `isSending = true`.

### Step 2: Detect new message
`handleMessagesCountChanged()` fires (may fire before or after `handleSendingChanged`).

**Safety net:** If `pendingSendScrollMessageId` is nil and a new user message appeared, set it:
```swift
if scrollState.pendingSendScrollMessageId == nil {
    if let lastUser = paginatedVisibleMessages.last(where: { $0.role == .user }),
       scrollState.lastMessageId != nil,
       lastUser.id != scrollState.lastMessageId,
       paginatedVisibleMessages.last?.id != scrollState.lastMessageId {
        scrollState.pendingSendScrollMessageId = lastUser.id
    }
}
```

**Also:** `handleSendingChanged()` sets the ID when `isSending` becomes true (unless it's a confirmation resume).

### Step 3: Scroll to bottom (deferred)
Once the user message is in `paginatedVisibleMessages`:
```swift
if scrollState.pendingSendScrollMessageId != nil,
   paginatedVisibleMessages.contains(where: { $0.id == scrollState.pendingSendScrollMessageId }) {
    let scrollBinding = $scrollPosition
    scrollState.pendingSendScrollMessageId = nil
    Task { @MainActor in
        withAnimation(VAnimation.standard) {
            scrollBinding.wrappedValue.scrollTo(edge: .bottom)
        }
    }
}
```

**Why deferred:** `Task { @MainActor in }` gives SwiftUI one run-loop tick to lay out the new cell in the LazyVStack before the scroll fires. Without this, the scroll targets the old content bottom and the user message appears off-screen.

**Why `.scrollTo(edge: .bottom)`:** The imperative method animates correctly. Value replacement (`ScrollPosition(edge: .bottom)`) doesn't animate.

**Why `VAnimation.standard`:** 0.25s easeInOut. Fast enough to feel responsive, slow enough to be smooth.

### Step 4: MinHeight pins user message to top
The thinking placeholder (or assistant message) has a minHeight wrapper:
```swift
.frame(minHeight: turnMinHeight, alignment: .top)
```
This fills the viewport below the user message, so after scroll-to-bottom the user message naturally sits at the top.

---

## MinHeight Calculation (Critical)

Three-path formula depending on the last user message:

```swift
// Path 1: No user message
estimatedUserHeight = 80

// Path 2: Heuristic-collapsed (text.count > 3,000 or > 40 lines)
estimatedUserHeight = NSString.boundingRect(previewText) + 60 + 30 + attachmentHeight

// Path 3: Normal (renders at full height)
estimatedUserHeight = NSString.boundingRect(fullText) + 60 + attachmentHeight

let composerHeight: CGFloat = 80        // static — composer is empty after send
let layoutPadding = VSpacing.md * 3 + 1 // top + bottom + inter-item + anchor
let turnMinHeight = containerHeight - composerHeight - estimatedUserHeight - layoutPadding
```

### Key decisions:
- **Uses `containerHeight`** (full chat pane from GeometryReader), NOT `scrollState.viewportHeight`. The viewport height fluctuates when the composer resizes — the container height is stable.
- **Composer is static 80pt.** We only care about the composer height when it's empty (after the user hits send). It grows when typing, but by then minHeight doesn't matter.
- **User message estimated via `NSString.boundingRect`** for word-wrap accuracy. Cell overhead is 60pt (bubble padding 24 + timestamp 24 + spacing 12). Attachment height is estimated per-type (images use grid layout at ~130pt/row, videos ~200pt, audio ~60pt, files ~40pt). No fixed cap — moderate messages render at full height; only heuristic-collapsed messages (> 3,000 chars / > 40 lines) use preview text height + 30pt "Show more" button.
- **MinHeight applies when `row.isLatestAssistant && row.message.id == state.rows.last?.message.id`.** No `isActiveTurn` gate — the minHeight persists after streaming ends so the viewport doesn't jump.

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
    onScrollToBottom()  // → scrollPosition = ScrollPosition(edge: .bottom)
}
```

**Why `dismissScrollToLatest()` inside the animation block:** So the exit transition (`.move(edge: .bottom).combined(with: .opacity)`) animates in sync with the scroll.

**Why value replacement for CTA but imperative for send-scroll:** The CTA doesn't need animation (spring handles it). Send-scroll needs `VAnimation.standard` which works with the imperative `.scrollTo(edge:)` method.

---

## Conversation Switching

```swift
.id(conversationId)                                    // Destroys + recreates ScrollView
.defaultScrollAnchor(.top, for: .initialOffset)        // New view starts at top
```

`handleAppear()` detects the switch via `scrollState.currentConversationId` comparison, calls `handleConversationSwitched()` which:
1. Cancels queued geometry callbacks (`ScrollGeometryUpdateDispatcher.shared.cancel`)
2. Resets all scroll state (`scrollState.reset(for:)`)
3. Seeds `lastMessageId`
4. Does NOT write to `scrollPosition` — `.defaultScrollAnchor(.top)` handles positioning

**No explicit scroll on switch.** The `.id()` recreation + `.defaultScrollAnchor` is sufficient.

---

## User Message Collapse

Only extremely large user messages (>3,000 characters or >40 lines) are collapsed. These use a text-truncation heuristic: the preview is limited to 1,200 characters / 24 lines with a trailing "..." indicator. A "Show more" / "Show less" button toggles between the truncated preview and full text.

Moderate-length user messages (under the heuristic threshold) render at full height with no collapse or height clipping. The previous height-based collapse (150pt cap with `onGeometryChange` measurement) was removed because it aggressively truncated typical user messages to ~7-8 lines, causing content to appear cut off (LUM-833).

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

---

## Files That Own Scroll Behavior

| File | Responsibility |
|------|---------------|
| `MessageListScrollState.swift` | Flat coordinator — geometry, CTA, pagination, anchor state |
| `MessageListView.swift` | ScrollView setup — position binding, anchor, indicators, overlay |
| `MessageListView+ScrollHandling.swift` | Geometry handler — updates state, triggers pagination |
| `MessageListView+Lifecycle.swift` | Send detection, scroll-to-bottom, conversation switch, anchor resolution |
| `MessageListContentView.swift` | ForEach rendering, minHeight wrapper, thinking placeholder |
| `MessageListHelperViews.swift` | ScrollToLatestOverlayView — CTA button |
| `TranscriptProjector.swift` | Thinking placeholder row injection |
| `TranscriptRenderModel.swift` | `isThinkingPlaceholder` flag on row model |
| `ChatBubble.swift` | User message collapse (instant estimate + gradient fade) |
