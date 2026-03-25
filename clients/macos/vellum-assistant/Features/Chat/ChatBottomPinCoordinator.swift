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

/// Centralizes the transcript follow-vs-detached state and coordinates
/// scroll-to-bottom pin requests.
///
/// The coordinator is decision-complete: while the user is detached from the
/// bottom, background requests from streaming, message growth, and progress
/// expansion are suppressed. Once the user explicitly returns to the bottom,
/// requests proceed immediately.
@MainActor
final class ChatBottomPinCoordinator {

    // MARK: - State

    /// Whether the viewport is logically following the bottom of the transcript.
    /// When false (detached), background pin requests are suppressed.
    private(set) var isFollowingBottom: Bool = true

    /// Callback invoked when the coordinator decides a scroll-to-bottom should
    /// be executed. The caller (typically MessageListView) performs the actual
    /// `proxy.scrollTo` call. The Bool return indicates whether the pin was
    /// accepted (false when `isSuppressed` is true inside the callback).
    var onPinRequested: ((_ reason: BottomPinRequestReason, _ animated: Bool) -> Bool)?

    /// Callback invoked when the follow/detach state changes, allowing the
    /// view to update `isNearBottom` and related reactive state.
    var onFollowStateChanged: ((_ isFollowing: Bool) -> Void)?

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
    /// complete suppression). When following, the request calls `onPinRequested`
    /// directly and returns immediately.
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

        log.debug("[BottomPin] pin reason=\(reason.rawValue) animated=\(animated) isFollowingBottom=\(self.isFollowingBottom)")
        onPinRequested?(reason, animated)
    }

    /// No-op — retained for call-site compatibility during the inline transition
    /// (PR 4 removes this method along with the coordinator itself).
    func cancelActiveSession(reason: BottomPinCancellationTrigger) {
        log.debug("[BottomPin] cancelActiveSession trigger=\(reason.rawValue) (no-op)")
    }

    /// Resets follow state, typically called on conversation switch.
    func reset(newConversationId: UUID? = nil) {
        isFollowingBottom = true
        onFollowStateChanged?(true)
    }
}
