import os
import os.signpost
import SwiftUI
import VellumAssistantShared

// MARK: - ScrollCoordinator.Phase Bridge

extension ScrollCoordinator.Phase {
    /// Maps SwiftUI's `ScrollPhase` to the coordinator's phase abstraction.
    /// Lives in the view layer (not in ScrollCoordinator) to keep the
    /// coordinator free of SwiftUI imports.
    static func from(_ phase: ScrollPhase) -> ScrollCoordinator.Phase {
        switch phase {
        case .idle: .idle
        case .interacting: .interacting
        case .tracking: .interacting
        case .decelerating: .decelerating
        case .animating: .animating
        @unknown default: .idle
        }
    }
}

extension MessageListView {

    // MARK: - Coordinator Intent Execution

    /// Translates `ScrollCoordinator.OutputIntent`s into concrete scroll
    /// mutations on `scrollState` / `ScrollPosition`. The coordinator is
    /// the policy layer; this method is the execution layer.
    func executeCoordinatorIntents(_ intents: [ScrollCoordinator.OutputIntent]) {
        for intent in intents {
            switch intent {
            case .scrollToBottom(let animated):
                if animated {
                    scrollState.scheduleDeferredBottomPin(animated: true)
                } else {
                    scrollState.requestPinToBottom(animated: false)
                }

            case .scrollToMessage(let anchorId, let anchor):
                let unitPoint: UnitPoint
                switch anchor {
                case .top: unitPoint = .top
                case .center: unitPoint = .center
                case .bottom: unitPoint = .bottom
                }
                scrollState.performScrollTo(anchorId.rawValue, anchor: unitPoint)

            case .showScrollToLatest:
                // The coordinator signals that the CTA should appear.
                // scrollState's mode-based UI sync handles visibility;
                // this is a forward-looking hook for when the coordinator
                // fully owns the CTA lifecycle.
                break

            case .hideIndicators:
                // Forward-looking hook — scrollState's syncUIImmediately
                // handles indicator visibility for now.
                break

            case .startRecoveryWindow:
                scrollState.bottomAnchorAppeared = false
                scrollState.recoveryDeadline = Date().addingTimeInterval(2.0)

            case .cancelRecoveryWindow:
                scrollState.recoveryDeadline = nil
            }
        }
    }
}

extension MessageListView {

    // MARK: - Scroll geometry handler

    /// Coalesces `onScrollGeometryChange` updates onto the next main-actor turn.
    ///
    /// macOS 26's `OnScrollGeometryChange` modifier faults when its action
    /// causes enough synchronous view-affecting state mutations to re-enter
    /// the modifier in the same frame. We only store the latest geometry
    /// snapshot inside the callback, then process it after the callback unwinds.
    func enqueueScrollGeometryUpdate(_ newState: ScrollGeometrySnapshot) {
        ScrollGeometryUpdateDispatcher.shared.enqueue(for: scrollState, snapshot: newState) { snapshot in
            handleScrollGeometryUpdate(snapshot)
        }
    }

    func handleScrollGeometryUpdate(_ newState: ScrollGeometrySnapshot) {
        // --- Scroll direction detection ---
        let effectiveContentHeight = newState.contentHeight
        let isScrollable = effectiveContentHeight > newState.containerHeight
        let isScrollingUp = newState.contentOffsetY < scrollState.lastContentOffsetY
        let previousContentHeight = scrollState.scrollContentHeight
        scrollState.scrollContentHeight = newState.contentHeight
        scrollState.scrollContainerHeight = newState.containerHeight
        scrollState.lastContentOffsetY = newState.contentOffsetY

        // Detach on user gesture (interacting) AND user-initiated momentum
        // (decelerating). A fast trackpad flick has a very brief .interacting
        // phase — sometimes only 1-2 geometry updates fire before the phase
        // transitions to .decelerating. If the first update hasn't registered
        // a position change yet, handleUserScrollUp() never fires and the CTA
        // never appears. .decelerating is exclusively user-initiated momentum
        // (programmatic scrolls use .animating), so it's safe to detect here.
        // Only detach when content is scrollable (prevents false detaches
        // on short conversations).
        let isUserScrollPhase = scrollState.scrollPhase == .interacting
            || scrollState.scrollPhase == .decelerating
        if isUserScrollPhase && isScrollingUp && isScrollable {
            // During .decelerating, check if the momentum is stale (pre-CTA).
            // When the user scrolls up and taps "Scroll to latest" while
            // momentum is active, the CTA fires requestPinToBottom and sets
            // mode to .followingBottom. But the residual upward momentum
            // generates geometry updates with isScrollingUp=true in
            // .decelerating phase — the very next update would fire
            // handleUserScrollUp(), undoing the CTA's mode transition and
            // creating a "scroll lock" effect.
            //
            // Only suppress during .decelerating (residual momentum from
            // before the CTA tap). .interacting (new deliberate trackpad
            // touch) is always respected — the user is explicitly starting
            // a new scroll gesture, overriding the CTA.
            if scrollState.scrollPhase == .decelerating,
               let pinTime = scrollState.lastUserInitiatedPinTime,
               Date().timeIntervalSince(pinTime) < 0.5 {
                // Stale momentum from before CTA tap — ignore.
            } else {
                // Route through coordinator for policy decision.
                let browseIntents = scrollCoordinator.handle(.manualBrowseIntent)
                executeCoordinatorIntents(browseIntents)
                // Keep scrollState in sync as runtime executor.
                scrollState.scrollRestoreTask?.cancel()
                scrollState.scrollRestoreTask = nil
                scrollState.handleUserScrollUp()
            }
        }

        // --- Phase guard (shared by bottom detection, auto-follow, recovery) ---
        // Only allow automatic scroll actions when scroll is fully at rest
        // (.idle). Block during ALL non-idle phases including .animating.
        //
        // Why no .animating exception: recovery calls non-animated
        // scrollToEdge(.bottom) which interrupts any in-flight spring
        // animation (e.g. the CTA's smooth scroll). The user sees the
        // spring start, then a jarring jump to bottom. By restricting
        // to .idle only, recovery waits until the animation completes,
        // then fires cleanly.
        //
        // This is safe for streaming auto-follow because the auto-follow
        // path uses non-animated scrollToEdge(.bottom) which doesn't
        // trigger .animating — the scroll position changes instantly and
        // scrollPhase stays .idle.
        //
        // Animated pins (handleSendingChanged, handleMessagesCountChanged)
        // briefly trigger .animating (~150ms with VAnimation.fast), during
        // which auto-follow is paused. After the animation completes and
        // phase returns to .idle, auto-follow resumes immediately.
        let phaseAllowsAutoFollow = !scrollState.scrollPhase.isScrolling

        // --- Viewport height update ---
        // Filter non-finite viewport heights and sub-pixel jitter.
        // A 0.5pt dead-zone prevents floating-point rounding differences
        // from triggering continuous updates that feed back into layout.
        let decision = PreferenceGeometryFilter.evaluate(
            newValue: newState.visibleRectHeight,
            previous: scrollState.viewportHeight,
            deadZone: 0.5
        )
        if case .accept(let accepted) = decision {
            os_signpost(.begin, log: PerfSignposts.log, name: "viewportHeightChanged")
            scrollState.viewportHeight = accepted
            os_signpost(.end, log: PerfSignposts.log, name: "viewportHeightChanged")
        }

        // --- Bottom detection (with hysteresis) ---
        // Asymmetric thresholds prevent oscillation during streaming:
        // content-height growth can briefly push distanceFromBottom past
        // the "at bottom" threshold before the scroll position catches
        // up, causing rapid true→false→true flips. A wider leave
        // threshold absorbs those transient spikes without overly
        // widening the idle-reattach zone (onScrollPhaseChange reattaches
        // when isAtBottom is true on idle).
        let distanceFromBottom = effectiveContentHeight - newState.contentOffsetY - newState.visibleRectHeight
        // Update coordinator's bottom state (hysteresis lives in coordinator).
        scrollCoordinator.updateBottomState(distanceFromBottom: distanceFromBottom)
        let nowAtBottom: Bool
        if scrollState.isAtBottom {
            // Stay "at bottom" until clearly scrolled away.
            nowAtBottom = distanceFromBottom.isFinite && distanceFromBottom <= 30
        } else {
            // Only re-enter "at bottom" when truly close.
            nowAtBottom = distanceFromBottom.isFinite && distanceFromBottom <= 10
        }
        if scrollState.isAtBottom != nowAtBottom {
            scrollState.isAtBottom = nowAtBottom
            // Only reattach during non-user-initiated phases. During
            // .interacting the user is actively scrolling — reattaching
            // would cause mode to oscillate between freeBrowsing and
            // followingBottom within the 16ms UI-sync debounce window,
            // preventing the CTA from ever appearing. The idle handler
            // in onScrollPhaseChange provides deferred reattach when
            // the scroll settles.
            if nowAtBottom, phaseAllowsAutoFollow {
                scrollState.handleReachedBottom()
            }
        }

        // --- Content-height-change auto-follow ---
        // Pin to bottom when content height changes in either direction:
        //   Growth  → streaming, new messages
        //   Shrinkage → LazyVStack height-estimate convergence after a
        //               conversation switch (estimated height overshoots,
        //               then shrinks as views materialize with actual heights)
        // The 0.5pt threshold filters sub-pixel layout noise. Safe from
        // feedback loops because pinning changes contentOffsetY, not
        // contentHeight.
        if abs(effectiveContentHeight - previousContentHeight) > 0.5,
           scrollState.mode.allowsAutoScroll,
           phaseAllowsAutoFollow {
            scrollState.requestPinToBottom()
        }
        // --- Persistent bottom-recovery ---
        // Independent of the content-height auto-follow. Catches cases
        // the height-change check misses:
        //   • LazyVStack estimate converging in <0.5pt increments
        //   • ID-based scroll landing short due to height estimation
        //     errors (long conversations with variable content like images)
        //   • Race conditions during rapid conversation switching
        //   • "False at-bottom" — viewport at the estimated bottom but
        //     actual content is above (LazyVStack blank space)
        //
        // Recovery uses the alternating edge/ID scroll strategy via
        // requestPinToBottom(forRecovery: true) → executeScrollToBottom
        // (forRecovery: true). Each call toggles recoveryAlternator,
        // producing a structurally different scroll command (edge-based
        // vs ID-based) that helps break potential deduplication. The
        // two strategies use different estimation paths: edge-based
        // computes a single total-content-height offset, ID-based sums
        // per-item estimates. This may land the viewport at slightly
        // different positions, helping LazyVStack converge faster.
        // Auto-follow (content-height changes) uses ID-based only —
        // edge-based can overshoot into blank space on long conversations.
        //
        // The repeated 100ms recovery cycle handles convergence —
        // each attempt materializes views near the actual bottom,
        // correcting estimates, until the bottom anchor materializes
        // and recovery stops.
        //
        // Recovery fires unconditionally until the bottom anchor view
        // has appeared (meaning LazyVStack materialized to the actual
        // bottom and isAtBottom is reliable) OR the 2-second deadline
        // expires (whichever comes first). The deadline is critical
        // because multiple paths reset bottomAnchorAppeared = false
        // while the anchor may already be visible in the hierarchy
        // (CTA taps, sends, resizes) — since onAppear only fires on
        // hierarchy transitions, the flag won't be re-set and recovery
        // would fire indefinitely without the time cutoff.
        // Only fires in initialLoad/followingBottom.
        //
        // https://developer.apple.com/documentation/swiftui/scrollposition
        let isInRecoveryWindow: Bool
        if scrollState.bottomAnchorAppeared {
            // Anchor materialized — isAtBottom is reliable now.
            isInRecoveryWindow = false
        } else if let deadline = scrollState.recoveryDeadline,
                  Date() < deadline {
            // Bottom anchor hasn't materialized yet and we're within
            // the 2-second hard time limit. Each recovery attempt
            // scrolls closer to the actual bottom, materializing more
            // views. Eventually the bottom anchor materializes and
            // recovery ends. The 100ms throttle limits this to at most
            // 10 attempts/second. Recovery naturally stops via:
            //   • bottomAnchorAppeared (anchor materializes)
            //   • User scroll-up (mode → freeBrowsing)
            //   • Conversation switch (reset())
            //   • 2-second deadline expiry (hard limit)
            // The deadline is critical because multiple paths reset
            // bottomAnchorAppeared = false while the anchor may already
            // be visible (CTA taps, sends, resizes). Since onAppear
            // only fires on hierarchy transitions, the anchor won't
            // re-fire if already materialized — without the deadline,
            // recovery would fire at 10Hz indefinitely.
            isInRecoveryWindow = true
        } else {
            isInRecoveryWindow = false
        }
        if scrollState.mode.allowsAutoScroll,
           phaseAllowsAutoFollow,
           effectiveContentHeight > newState.visibleRectHeight,
           (!nowAtBottom || isInRecoveryWindow) {
            // Throttle recovery to at most once per 100ms. Without this,
            // geometry updates at ~60fps fire requestPinToBottom every
            // ~16ms. LazyVStack needs time between scroll attempts to
            // materialize views at the new position — rapid-fire scrolls
            // keep yanking the viewport before materialization completes,
            // causing the chat to appear blank (especially in long
            // conversations). 100ms ≈ 6 frames at 60fps — enough for
            // LazyVStack to materialize a batch of views while still
            // feeling responsive.
            let now = Date()
            if now.timeIntervalSince(scrollState.lastRecoveryAttempt) >= 0.1 {
                scrollState.lastRecoveryAttempt = now
                scrollState.requestPinToBottom(forRecovery: true)
            }
        }

        // --- Pagination trigger ---
        // Derive pagination from scroll offset instead of a
        // GeometryReader+PreferenceKey sentinel inside the
        // LazyVStack. The old sentinel reported minY in the
        // ScrollView coordinate space (0 at viewport top,
        // negative when scrolled past). contentOffsetY has
        // inverted sign (0 at top, positive when scrolled
        // down), so we negate to preserve the same semantics.
        handlePaginationSentinel(
            sentinelMinY: -newState.contentOffsetY
        )
    }

    // MARK: - Pagination sentinel

    /// Evaluates a pagination sentinel preference change and triggers pagination
    /// if the sentinel entered the trigger band.
    func handlePaginationSentinel(sentinelMinY: CGFloat) {
        guard PreferenceGeometryFilter.evaluate(
            newValue: sentinelMinY,
            previous: .infinity,
            deadZone: 0
        ) != .rejectNonFinite else { return }

        let isInRange = MessageListPaginationTriggerPolicy.isInTriggerBand(
            sentinelMinY: sentinelMinY,
            viewportHeight: scrollState.viewportHeight
        )
        let shouldFire = MessageListPaginationTriggerPolicy.shouldTrigger(
            sentinelMinY: sentinelMinY,
            viewportHeight: scrollState.viewportHeight,
            wasInRange: scrollState.wasPaginationTriggerInRange
        )
        guard shouldFire,
              hasMoreMessages,
              !isLoadingMoreMessages,
              !scrollState.isPaginationInFlight
        else { return }

        guard Date().timeIntervalSince(scrollState.lastPaginationCompletedAt) > 0.5 else { return }

        // Fire pagination — update edge state only now so guard rejections
        // (including cooldown) don't consume the one-shot rising edge.
        scrollState.wasPaginationTriggerInRange = isInRange
        scrollState.isPaginationInFlight = true
        let anchorId = scrollState.derivedStateCache.cachedFirstVisibleMessageId
        let taskConversationId = scrollState.currentConversationId
        os_signpost(.event, log: PerfSignposts.log, name: "paginationSentinelFired")
        scrollState.paginationTask = Task { [scrollState] in
            defer {
                if !Task.isCancelled {
                    scrollState.lastPaginationCompletedAt = Date()
                    scrollState.isPaginationInFlight = false
                    scrollState.paginationTask = nil
                } else if scrollState.paginationTask == nil,
                          scrollState.currentConversationId == taskConversationId {
                    scrollState.lastPaginationCompletedAt = Date()
                    scrollState.isPaginationInFlight = false
                }
            }
            let hadMore = await loadPreviousMessagePage?() ?? false
            if hadMore, let id = anchorId {
                    scrollState.beginStabilization(.pagination)
                    try? await Task.sleep(nanoseconds: 100_000_000)
                    guard !Task.isCancelled else {
                        scrollState.endStabilization()
                        return
                    }
                    os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=paginationAnchor")
                    scrollState.performScrollTo(id, anchor: .top)
                    scrollState.endStabilization()
            }
        }
    }

    // MARK: - Scroll helpers

    /// Restores scroll-to-bottom after a conversation load or app restart.
    /// Issues a delayed fallback pin that catches cases where the declarative
    /// `ScrollPosition(edge: .bottom)` hasn't fully resolved for the new content.
    /// The `isAtBottom` guard is intentionally omitted: during a conversation
    /// switch, `isAtBottom` is unreliable because scroll geometry hasn't updated
    /// yet for the new content. An extra pin when already at bottom is a no-op.
    func restoreScrollToBottom() {
        scrollState.scrollRestoreTask?.cancel()
        scrollState.scrollRestoreTask = Task { @MainActor [scrollState] in
            try? await Task.sleep(nanoseconds: 100_000_000)
            guard !Task.isCancelled else { return }
            if anchorMessageId == nil,
               case .freeBrowsing = scrollState.mode {
                // User scrolled away during the restore window — respect that.
            } else if anchorMessageId == nil,
                      case .programmaticScroll = scrollState.mode {
                // A deep-link anchor scroll resolved and cleared anchorMessageId
                // before this task fired. Don't yank the viewport back to bottom.
            } else if anchorMessageId == nil,
                      case .stabilizing = scrollState.mode {
                // A resize or expansion stabilization started during the
                // restore window. Overriding with .followingBottom would
                // leak activeStabilizationCount — endStabilization() checks
                // `guard case .stabilizing = mode` and bails if mode changed.
            } else if anchorMessageId == nil {
                os_signpost(.event, log: PerfSignposts.log, name: "scrollRestoreStage", "stage=fallback")
                scrollState.transition(to: .followingBottom)
                scrollState.requestPinToBottom()
            }
            scrollState.scrollRestoreTask = nil
        }
    }

    /// Flash-highlights a message and schedules auto-dismiss after 1.5 seconds.
    func flashHighlight(messageId: UUID) {
        scrollState.highlightDismissTask?.cancel()
        highlightedMessageId = messageId
        scrollState.highlightDismissTask = Task { @MainActor [scrollState] in
            do {
                try await Task.sleep(nanoseconds: 1_500_000_000)
            } catch { return }
            guard !Task.isCancelled else { return }
            withAnimation(VAnimation.slow) {
                highlightedMessageId = nil
            }
            scrollState.highlightDismissTask = nil
        }
    }

    /// Configures scroll action closures on the scroll state so it can
    /// perform programmatic scrolls via the view-owned ScrollPosition.
    func configureScrollCallbacks() {
        let binding = $scrollPosition
        // Use the imperative `.scrollTo()` mutating methods on the
        // binding's wrappedValue. This is Apple's recommended pattern
        // for programmatic scrolling (see ScrollPosition docs example:
        // `position.scrollTo(edge: .bottom)`). The mutating method
        // modifies the ScrollPosition through the binding's inout
        // accessor, triggering the @State setter. This pattern is
        // already used elsewhere in the codebase (handleAppear anchor
        // scroll, handleSendingChanged user-message scroll).
        //
        // The previous approach used value replacement
        // (`binding.wrappedValue = ScrollPosition(edge:)`) which was
        // empirically unreliable — repeated writes of the same struct
        // value were silently deduped by SwiftUI's binding update
        // mechanism. The imperative method is a command ("scroll to X
        // now") rather than a state declaration ("scroll state is X").
        scrollState.scrollTo = { id, anchor in
            if let uuidId = id as? UUID {
                binding.wrappedValue.scrollTo(id: uuidId, anchor: anchor)
            } else if let stringId = id as? String {
                binding.wrappedValue.scrollTo(id: stringId, anchor: anchor)
            }
        }
        scrollState.scrollToEdge = { edge in
            binding.wrappedValue.scrollTo(edge: edge)
        }
        // Cancel in-flight spring animations on the scroll position.
        //
        // SwiftUI's `withAnimation { scrollPosition = ScrollPosition(...) }`
        // creates a SwiftUI-managed spring animation that does NOT cancel
        // when the user starts a new scroll gesture — unlike UIKit's
        // `UIScrollView.setContentOffset(animated:)` which cancels on touch.
        //
        // Writing an empty `ScrollPosition()` (no target) with animations
        // disabled overwrites the animated value, cancelling the spring.
        // During `.interacting` phase the user's gesture has priority, so
        // the empty position doesn't move the viewport — it just stops the
        // animation from fighting the user's drag.
        scrollState.cancelScrollAnimation = {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                binding.wrappedValue = ScrollPosition()
            }
        }
        scrollState.currentConversationId = conversationId
    }
}
