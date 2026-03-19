import SwiftUI

enum ConversationAvatarFollower {
    static let coalesceInterval: TimeInterval = 0.1
    static let visibilityPadding: CGFloat = 24
    static let verticalOffset: CGFloat = 10
    static let avatarSize: CGFloat = 52
    static let bottomInset: CGFloat = avatarSize + verticalOffset + 2
    static let spring = Animation.interactiveSpring(response: 0.28, dampingFraction: 0.84, blendDuration: 0.12)

    static func shouldShow(anchorY: CGFloat, viewportHeight: CGFloat) -> Bool {
        guard anchorY.isFinite, viewportHeight.isFinite else { return false }
        return anchorY >= -visibilityPadding && anchorY <= viewportHeight + visibilityPadding
    }

    /// Hidden avatar positions do not affect rendering, so avoid updating the
    /// stored target unless visibility changes or the visible avatar actually moves.
    static func shouldUpdateTarget(
        previousAnchorY: CGFloat,
        newAnchorY: CGFloat,
        viewportHeight: CGFloat,
        movementThreshold: CGFloat = 20
    ) -> Bool {
        let wasVisible = shouldShow(anchorY: previousAnchorY, viewportHeight: viewportHeight)
        let isVisible = shouldShow(anchorY: newAnchorY, viewportHeight: viewportHeight)

        if wasVisible != isVisible { return true }
        if previousAnchorY.isFinite != newAnchorY.isFinite { return true }
        guard isVisible else { return false }
        return abs(previousAnchorY - newAnchorY) > movementThreshold
    }

    static func shouldCoalesce(isSending: Bool, isThinking: Bool, isLastMessageStreaming: Bool) -> Bool {
        isSending || isThinking || isLastMessageStreaming
    }

    static func coalescedDelay(lastAppliedAt: Date?, now: Date) -> TimeInterval {
        guard let lastAppliedAt else { return 0 }
        let elapsed = now.timeIntervalSince(lastAppliedAt)
        return max(0, coalesceInterval - elapsed)
    }

    static func smoothingDelay(
        isSending: Bool,
        isThinking: Bool,
        isLastMessageStreaming: Bool,
        lastAppliedAt: Date?,
        now: Date
    ) -> TimeInterval {
        guard shouldCoalesce(
            isSending: isSending,
            isThinking: isThinking,
            isLastMessageStreaming: isLastMessageStreaming
        ) else { return 0 }
        return coalescedDelay(lastAppliedAt: lastAppliedAt, now: now)
    }
}

/// Preference key that tracks the conversation-tail anchor's maxY so the avatar
/// can follow the latest rendered content rather than staying pinned above input.
struct ConversationTailAnchorYKey: PreferenceKey {
    static var defaultValue: CGFloat = .infinity

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        // Use min so sibling views in the LazyVStack (which report the default
        // value of .infinity) don't overwrite the anchor's actual Y position.
        value = min(value, nextValue())
    }
}
