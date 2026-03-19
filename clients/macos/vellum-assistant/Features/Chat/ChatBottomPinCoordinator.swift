import Foundation
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "ChatBottomPinCoordinator")

// MARK: - Request Reasons & User Actions

/// Reasons the system may request a scroll-to-bottom pin.
enum BottomPinRequestReason: String, Sendable {
    /// Initial conversation load / restore from disk.
    case initialRestore
    /// Streaming tokens are arriving on the last message.
    case streaming
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
             (.streaming, .streaming),
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
            log.debug("Detached from bottom (trigger: \(trigger.rawValue))")
            onFollowStateChanged?(false)
        }
    }

    /// Transitions to the following state, allowing pin requests to proceed.
    func reattach() {
        let wasDetached = !isFollowingBottom
        isFollowingBottom = true

        if wasDetached {
            log.debug("Re-attached to bottom")
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
            log.debug("Pin request suppressed (detached) — reason: \(reason.rawValue)")
            return
        }

        // Coalesce into active session if possible.
        if let session = activeSession, session.canCoalesce(reason: reason, conversationId: conversationId) {
            log.debug("Coalescing \(reason.rawValue) into active session (attempt \(session.attemptCount)/\(BottomPinSession.maxRetries))")
            // The existing session task continues; no new task needed.
            // Just record that a new request arrived (the retry loop will
            // pick it up on its next iteration).
            return
        }

        // Cancel any stale session before starting a new one.
        cancelActiveSession(reason: .conversationSwitch)

        // Start a new bounded session.
        let session = BottomPinSession(
            conversationId: conversationId,
            reason: reason,
            startTime: CFAbsoluteTimeGetCurrent()
        )
        activeSession = session
        startSessionTask(animated: animated)
    }

    /// Cancels the active pin session and its associated task.
    func cancelActiveSession(reason: BottomPinCancellationTrigger) {
        guard activeSession != nil else { return }
        log.debug("Cancelling active pin session (reason: \(reason.rawValue))")
        sessionTask?.cancel()
        sessionTask = nil
        activeSession = nil
    }

    /// Resets all state, typically called on conversation switch.
    func reset(newConversationId: UUID? = nil) {
        cancelActiveSession(reason: .conversationSwitch)
        isFollowingBottom = true
        onFollowStateChanged?(true)
    }

    // MARK: - Session Task

    private func startSessionTask(animated: Bool) {
        sessionTask?.cancel()

        sessionTask = Task { @MainActor [weak self] in
            guard let self else { return }

            // Immediate first attempt.
            guard var session = self.activeSession else { return }
            session.recordAttempt()
            self.activeSession = session
            let pinned = self.onPinRequested?(session.reason, animated) ?? false

            if pinned {
                self.completeSession()
                return
            }

            // Bounded retry loop.
            while !Task.isCancelled {
                guard var currentSession = self.activeSession else { break }
                guard !currentSession.isExhausted else {
                    log.debug("Pin session exhausted after \(currentSession.attemptCount) attempts")
                    break
                }

                // Check session timeout.
                let elapsed = CFAbsoluteTimeGetCurrent() - currentSession.startTime
                if elapsed > Self.sessionTimeout {
                    log.debug("Pin session timed out after \(String(format: "%.0f", elapsed * 1000))ms")
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
                    log.debug("Pin retry aborted — user detached during sleep")
                    break
                }

                currentSession.recordAttempt()
                self.activeSession = currentSession
                let succeeded = self.onPinRequested?(currentSession.reason, animated) ?? false

                if succeeded {
                    self.completeSession()
                    return
                }
            }

            // Clean up if we fell through without completing.
            self.completeSession()
        }
    }

    private func completeSession() {
        sessionTask = nil
        activeSession = nil
    }

    deinit {
        sessionTask?.cancel()
    }
}
