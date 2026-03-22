import Foundation
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "ChatBottomPinCoordinator")

// MARK: - Coordinator

/// Centralizes the transcript follow-vs-detached state and provides a single
/// `scrollToBottom()` entry point for initial load positioning and the
/// "Scroll to latest" button.
///
/// The coordinator is decision-complete: while the user is detached from the
/// bottom, `scrollToBottom()` calls are suppressed. Once the user explicitly
/// returns to the bottom via `handleUserAction(.scrollToBottom)` or
/// `.jumpToLatest`, the follow state is re-armed.
@MainActor
final class ChatBottomPinCoordinator {

    // MARK: - State

    /// Whether the viewport is logically following the bottom of the transcript.
    /// When false (detached), `scrollToBottom()` calls are suppressed.
    private(set) var isFollowingBottom: Bool = true

    /// Callback invoked when the coordinator decides a scroll-to-bottom should
    /// be executed. The caller (typically MessageListView) performs the actual
    /// `proxy.scrollTo` call. The Bool return indicates whether the pin was
    /// successful (anchor is within viewport).
    var onPinRequested: (() -> Bool)?

    /// Callback invoked when the follow/detach state changes, allowing the
    /// view to update `isNearBottom` and related reactive state.
    var onFollowStateChanged: ((_ isFollowing: Bool) -> Void)?

    // MARK: - User Actions

    /// User-initiated actions that affect the follow/detach state machine.
    enum UserAction: Sendable {
        /// Physical scroll-wheel / trackpad upward movement.
        case scrollUp
        /// User explicitly scrolled to the bottom (wheel hit bottom, or clicked "Scroll to latest").
        case scrollToBottom
        /// User clicked "Jump to latest" or equivalent explicit re-tether action.
        case jumpToLatest
    }

    /// Processes a user-initiated action that affects follow/detach state.
    func handleUserAction(_ action: UserAction) {
        switch action {
        case .scrollUp:
            detach()

        case .scrollToBottom, .jumpToLatest:
            reattach()
        }
    }

    // MARK: - Scroll to Bottom

    /// Active initial-load retry task, cancelled on detach or conversation switch.
    private var initialLoadTask: Task<Void, Never>?

    /// Requests a single synchronous scroll-to-bottom. Used by the
    /// "Scroll to latest" button.
    ///
    /// When the user is detached, the request is silently suppressed.
    @discardableResult
    func scrollToBottom() -> Bool {
        guard isFollowingBottom else {
            log.debug("[BottomPin] suppressed scrollToBottom isFollowingBottom=false")
            return false
        }

        log.debug("[BottomPin] scrollToBottom isFollowingBottom=\(self.isFollowingBottom)")
        let pinned = onPinRequested?() ?? false
        log.debug("[BottomPin] scrollToBottom result=\(pinned)")
        return pinned
    }

    /// Scroll to bottom with bounded retries for initial load positioning.
    /// Layout may not be ready on the first attempt after a conversation switch,
    /// so retries up to 3 times with 50ms intervals (150ms total window).
    func scrollToBottomWithRetry() {
        initialLoadTask?.cancel()

        // Try immediately first
        if scrollToBottom() { return }

        // Retry asynchronously if the first attempt failed
        initialLoadTask = Task { [weak self] in
            for attempt in 1...3 {
                try? await Task.sleep(nanoseconds: 50_000_000) // 50ms
                guard !Task.isCancelled else { return }
                guard let self, self.isFollowingBottom else { return }
                if self.scrollToBottom() {
                    log.debug("[BottomPin] initialLoad succeeded on retry \(attempt)")
                    return
                }
            }
        }
    }

    // MARK: - Follow/Detach State Machine

    /// Transitions to the detached state, suppressing all scroll-to-bottom requests.
    func detach() {
        let wasFollowing = isFollowingBottom
        isFollowingBottom = false
        initialLoadTask?.cancel()
        initialLoadTask = nil

        if wasFollowing {
            log.debug("[BottomPin] detach isFollowingBottom=false")
            onFollowStateChanged?(false)
        }
    }

    /// Transitions to the following state, allowing scroll-to-bottom requests to proceed.
    func reattach() {
        let wasDetached = !isFollowingBottom
        isFollowingBottom = true

        if wasDetached {
            log.debug("[BottomPin] reattach isFollowingBottom=true")
            onFollowStateChanged?(true)
        }
    }

    /// Resets all state, typically called on conversation switch.
    func reset() {
        initialLoadTask?.cancel()
        initialLoadTask = nil
        isFollowingBottom = true
        onFollowStateChanged?(true)
    }
}
