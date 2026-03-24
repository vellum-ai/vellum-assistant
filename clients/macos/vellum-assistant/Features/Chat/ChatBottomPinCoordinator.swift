import Foundation
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "ChatBottomPinCoordinator")

// MARK: - Request Reasons & User Actions

/// Reasons the system may request a scroll-to-bottom pin.
enum BottomPinRequestReason: String, Sendable {
    /// Initial conversation load / restore from disk.
    case initialRestore
    /// A new message was appended to the conversation.
    case messageCount
    /// An inline element (progress card, tool output) expanded its height.
    case expansion
    /// The chat container was resized (sidebar toggle, window drag).
    case resize
}

/// User-initiated actions that affect the follow/detach state machine.
enum BottomPinUserAction: Sendable {
    /// Physical scroll-wheel / trackpad upward movement.
    case scrollUp
    /// User explicitly scrolled to the bottom (wheel hit bottom, or clicked "Scroll to latest").
    case scrollToBottom
    /// User clicked "Jump to latest" or equivalent explicit re-tether action.
    case jumpToLatest
}

// MARK: - Pin Session

/// Represents a single bounded scroll-to-bottom retry session.
/// Sessions coalesce duplicate requests and cap total retry attempts.
struct BottomPinSession: Sendable {
    /// Stable identifier for tracing this session across log entries.
    let sessionId: UUID
    /// The conversation this session targets.
    let conversationId: UUID
    /// The reason that initiated this session.
    let reason: BottomPinRequestReason
    /// Number of retry attempts executed so far.
    private(set) var attemptCount: Int = 0
    /// Wall-clock time the session was created.
    let startTime: CFAbsoluteTime

    /// Maximum retries before the session self-terminates.
    /// Prevents an unbounded series of pin attempts from a single trigger.
    static let maxRetries: Int = 5

    /// Whether the session has exhausted its retry budget.
    var isExhausted: Bool { attemptCount >= Self.maxRetries }

    /// Records a retry attempt. Returns false if the budget is exhausted.
    @discardableResult
    mutating func recordAttempt() -> Bool {
        guard !isExhausted else { return false }
        attemptCount += 1
        return true
    }

    /// Elapsed milliseconds since the session was created.
    var elapsedMs: Int {
        Int((CFAbsoluteTimeGetCurrent() - startTime) * 1000)
    }

    /// Whether this session can coalesce a new request with the given reason
    /// and conversation. Coalescing merges duplicates into the existing session
    /// instead of creating a new retry loop.
    func canCoalesce(reason: BottomPinRequestReason, conversationId: UUID) -> Bool {
        guard self.conversationId == conversationId else { return false }
        guard !isExhausted else { return false }
        // Requests coalesce freely when they share the same reason within the same conversation.
        // Different reasons (e.g. resize vs expansion) start a fresh session.
        switch (self.reason, reason) {
        case (.initialRestore, .initialRestore),
             (.expansion, .expansion),
             (.messageCount, .messageCount),
             (.resize, .resize):
            return true
        default:
            return false
        }
    }
}

// MARK: - Cancellation Triggers

/// Events that cancel the active pin session.
enum BottomPinCancellationTrigger: String, Sendable {
    /// User scrolled up away from the bottom.
    case userScrollUp
    /// A deep-link anchor was set, handing off scroll control.
    case deepLinkAnchorHandoff
    /// Pagination scroll-position restore is in progress.
    case paginationRestore
    /// The active conversation changed.
    case conversationSwitch
}

// MARK: - Coordinator

/// Centralizes the transcript follow-vs-detached state and coordinates bounded
/// scroll-to-bottom retry sessions.
///
/// The coordinator is decision-complete: while the user is detached from the
/// bottom, background requests from streaming, message growth, and progress
/// expansion are suppressed. Once the user explicitly returns to the bottom,
/// requests may schedule a bounded retry sequence again.
///
/// Only one pin session is active at a time. Duplicate requests for the same
/// conversation inside the active window merge into the existing session
/// instead of creating a fresh loop.
@MainActor
final class ChatBottomPinCoordinator {

    // MARK: - State

    /// Whether the viewport is logically following the bottom of the transcript.
    /// When false (detached), background pin requests are suppressed.
    private(set) var isFollowingBottom: Bool = true

    /// The currently active pin session, if any.
    private(set) var activeSession: BottomPinSession?

    /// The in-flight async task driving the active session's retry loop.
    private var sessionTask: Task<Void, Never>?

    /// Monotonically increasing generation counter. Incremented each time a new
    /// session task is started so that stale tasks don't clobber newer sessions.
    private var sessionGeneration: Int = 0

    /// Timestamp of the last conversation switch (set by `reset()`).
    /// During the grace period after a switch, all pin reasons coalesce
    /// to prevent competing sessions from initialRestore + messageCount + expansion.
    private var lastResetTime: CFAbsoluteTime?

    /// Duration after a conversation switch during which all pin reasons
    /// coalesce into the active session regardless of reason type.
    static let initialLoadGracePeriod: TimeInterval = 0.5

    /// Callback invoked when the coordinator decides a scroll-to-bottom should
    /// be executed. The caller (typically MessageListView) performs the actual
    /// `proxy.scrollTo` call. The Bool return indicates whether the pin was
    /// successful (anchor is within viewport).
    var onPinRequested: ((_ reason: BottomPinRequestReason, _ animated: Bool) -> Bool)?

    /// Callback invoked when the follow/detach state changes, allowing the
    /// view to update `isNearBottom` and related reactive state.
    var onFollowStateChanged: ((_ isFollowing: Bool) -> Void)?

    // MARK: - Configuration

    /// Delay between retry attempts in a pin session.
    static let retryInterval: UInt64 = 50_000_000 // 50ms

    /// Maximum elapsed time for a single pin session before it self-terminates,
    /// even if retries remain. Prevents stale sessions from lingering.
    static let sessionTimeout: TimeInterval = 0.5

    // MARK: - Follow/Detach State Machine

    /// Transitions to the detached state, suppressing all background pin requests.
    func detach(trigger: BottomPinCancellationTrigger) {
        let wasFollowing = isFollowingBottom
        isFollowingBottom = false
        cancelActiveSession(reason: trigger)

        if wasFollowing {
            log.debug("[BottomPin] detach trigger=\(trigger.rawValue) isFollowingBottom=false")
            onFollowStateChanged?(false)
        }
    }

    /// Transitions to the following state, allowing pin requests to proceed.
    func reattach() {
        let wasDetached = !isFollowingBottom
        isFollowingBottom = true

        if wasDetached {
            log.debug("[BottomPin] reattach isFollowingBottom=true")
            onFollowStateChanged?(true)
        }
    }

    // MARK: - User Actions

    /// Processes a user-initiated action that affects follow/detach state.
    func handleUserAction(_ action: BottomPinUserAction) {
        switch action {
        case .scrollUp:
            detach(trigger: .userScrollUp)

        case .scrollToBottom, .jumpToLatest:
            reattach()
        }
    }

    // MARK: - Pin Requests

    /// Requests a scroll-to-bottom pin for the given reason.
    ///
    /// When the user is detached, the request is silently suppressed (decision-
    /// complete suppression). When following, the request either coalesces into
    /// the active session or starts a new bounded session.
    ///
    /// - Parameters:
    ///   - reason: Why the pin is being requested.
    ///   - conversationId: The conversation the request targets.
    ///   - animated: Whether the scroll should be animated.
    func requestPin(
        reason: BottomPinRequestReason,
        conversationId: UUID,
        animated: Bool = false
    ) {
        // Decision-complete suppression: detached users are not yanked to bottom.
        guard isFollowingBottom else {
            log.debug("[BottomPin] suppressed reason=\(reason.rawValue) isFollowingBottom=false")
            return
        }

        // Coalesce into active session if possible.
        // During the initial-load grace period after a conversation switch,
        // all pin reasons coalesce (regardless of reason type) to prevent
        // competing sessions from initialRestore + messageCount + expansion.
        let inGracePeriod = lastResetTime.map { CFAbsoluteTimeGetCurrent() - $0 < Self.initialLoadGracePeriod } ?? false
        let canCoalesce = if let session = activeSession {
            inGracePeriod
                ? (session.conversationId == conversationId && !session.isExhausted)
                : session.canCoalesce(reason: reason, conversationId: conversationId)
        } else {
            false
        }
        if canCoalesce {
            let session = activeSession!
            log.debug("[BottomPin] coalesce sid=\(session.sessionId) reason=\(reason.rawValue) attempt=\(session.attemptCount)/\(BottomPinSession.maxRetries) elapsedMs=\(session.elapsedMs) gracePeriod=\(inGracePeriod) isFollowingBottom=\(self.isFollowingBottom)")
            // The existing session task continues; no new task needed.
            // Just record that a new request arrived (the retry loop will
            // pick it up on its next iteration).
            return
        }

        // Cancel any stale session before starting a new one.
        cancelActiveSession(reason: .conversationSwitch)

        // Start a new bounded session.
        let session = BottomPinSession(
            sessionId: UUID(),
            conversationId: conversationId,
            reason: reason,
            startTime: CFAbsoluteTimeGetCurrent()
        )
        activeSession = session
        log.debug("[BottomPin] start sid=\(session.sessionId) reason=\(reason.rawValue) animated=\(animated) isFollowingBottom=\(self.isFollowingBottom)")
        startSessionTask(animated: animated)
    }

    /// Cancels the active pin session and its associated task.
    func cancelActiveSession(reason: BottomPinCancellationTrigger) {
        guard let session = activeSession else { return }
        log.debug("[BottomPin] cancel sid=\(session.sessionId) trigger=\(reason.rawValue) attempt=\(session.attemptCount)/\(BottomPinSession.maxRetries) elapsedMs=\(session.elapsedMs) isFollowingBottom=\(self.isFollowingBottom)")
        sessionTask?.cancel()
        sessionTask = nil
        activeSession = nil
    }

    /// Resets all state, typically called on conversation switch.
    func reset(newConversationId: UUID? = nil) {
        cancelActiveSession(reason: .conversationSwitch)
        isFollowingBottom = true
        lastResetTime = CFAbsoluteTimeGetCurrent()
        onFollowStateChanged?(true)
    }

    // MARK: - Session Task

    private func startSessionTask(animated: Bool) {
        sessionTask?.cancel()
        sessionGeneration += 1
        let generation = sessionGeneration

        // Immediate first attempt — synchronous so callers see the result
        // before yielding (important for tests and single-frame UI updates).
        guard var session = activeSession else { return }
        session.recordAttempt()
        activeSession = session
        log.debug("[BottomPin] immediateAttempt sid=\(session.sessionId) reason=\(session.reason.rawValue) animated=\(animated) attempt=\(session.attemptCount)/\(BottomPinSession.maxRetries) elapsedMs=\(session.elapsedMs) isFollowingBottom=\(self.isFollowingBottom)")
        let pinned = onPinRequested?(session.reason, animated) ?? false

        if pinned {
            log.debug("[BottomPin] success sid=\(session.sessionId) attempt=\(session.attemptCount)/\(BottomPinSession.maxRetries) elapsedMs=\(session.elapsedMs)")
            completeSession(generation: generation)
            return
        }

        // Async bounded retry loop for subsequent attempts.
        sessionTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self else { break }
                guard self.sessionGeneration == generation else {
                    if let s = self.activeSession {
                        log.debug("[BottomPin] generationMismatch sid=\(s.sessionId) staleGen=\(generation) currentGen=\(self.sessionGeneration)")
                    }
                    break
                }
                guard var currentSession = self.activeSession else { break }
                guard !currentSession.isExhausted else {
                    log.debug("[BottomPin] exhausted sid=\(currentSession.sessionId) attempt=\(currentSession.attemptCount)/\(BottomPinSession.maxRetries) elapsedMs=\(currentSession.elapsedMs) isFollowingBottom=\(self.isFollowingBottom)")
                    break
                }

                // Check session timeout.
                let elapsed = CFAbsoluteTimeGetCurrent() - currentSession.startTime
                if elapsed > Self.sessionTimeout {
                    let elapsedMs = Int(elapsed * 1000)
                    log.debug("[BottomPin] timeout sid=\(currentSession.sessionId) attempt=\(currentSession.attemptCount)/\(BottomPinSession.maxRetries) elapsedMs=\(elapsedMs) isFollowingBottom=\(self.isFollowingBottom)")
                    break
                }

                do {
                    try await Task.sleep(nanoseconds: Self.retryInterval)
                } catch {
                    break
                }
                guard !Task.isCancelled else { break }

                // Re-check follow state after sleep — user may have scrolled up.
                guard self.isFollowingBottom else {
                    log.debug("[BottomPin] retryAborted sid=\(currentSession.sessionId) reason=detachedDuringSleep attempt=\(currentSession.attemptCount)/\(BottomPinSession.maxRetries) elapsedMs=\(currentSession.elapsedMs) isFollowingBottom=false")
                    break
                }

                currentSession.recordAttempt()
                self.activeSession = currentSession
                log.debug("[BottomPin] retryAttempt sid=\(currentSession.sessionId) reason=\(currentSession.reason.rawValue) animated=\(animated) attempt=\(currentSession.attemptCount)/\(BottomPinSession.maxRetries) elapsedMs=\(currentSession.elapsedMs) isFollowingBottom=\(self.isFollowingBottom)")
                let succeeded = self.onPinRequested?(currentSession.reason, animated) ?? false

                if succeeded {
                    log.debug("[BottomPin] success sid=\(currentSession.sessionId) attempt=\(currentSession.attemptCount)/\(BottomPinSession.maxRetries) elapsedMs=\(currentSession.elapsedMs)")
                    self.completeSession(generation: generation)
                    return
                }
            }

            // Clean up if we fell through without completing.
            if let self, let s = self.activeSession, self.sessionGeneration == generation {
                log.debug("[BottomPin] sessionEnd sid=\(s.sessionId) attempt=\(s.attemptCount)/\(BottomPinSession.maxRetries) elapsedMs=\(s.elapsedMs) isFollowingBottom=\(self.isFollowingBottom)")
            }
            self?.completeSession(generation: generation)
        }
    }

    private func completeSession(generation: Int) {
        guard sessionGeneration == generation else { return }
        sessionTask = nil
        activeSession = nil
    }

    deinit {
        sessionTask?.cancel()
    }
}
