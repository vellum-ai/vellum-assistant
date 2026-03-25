import Foundation

/// Centralizes the bottom-visibility decision with hysteresis to prevent
/// rapid `anchorIsVisible` toggling during scroll.
///
/// The enter/leave thresholds create a 10pt dead zone (20–30pt) where the
/// visibility state is sticky — it stays in whichever state it was already in.
/// This prevents the "Scroll to latest" button from flickering when the user
/// scrolls near the bottom boundary.
enum BottomVisibilityPolicy {
    /// Threshold to ENTER visible state (must be ≤ this to become visible)
    static let enterThreshold: CGFloat = 20
    /// Threshold to LEAVE visible state (must be > this to become invisible)
    static let leaveThreshold: CGFloat = 30

    /// Returns the new visibility state given the current state and distance.
    static func evaluate(currentlyVisible: Bool, distanceFromBottom: CGFloat) -> Bool {
        if currentlyVisible {
            return distanceFromBottom >= -leaveThreshold && distanceFromBottom <= leaveThreshold
        } else {
            return distanceFromBottom >= -enterThreshold && distanceFromBottom <= enterThreshold
        }
    }

    /// Whether the user is close enough to bottom for auto-reattach on idle,
    /// independent of the hysteresis state. Used by onScrollPhaseChange to
    /// re-tether when the user stops scrolling near the bottom.
    static func isNearEnoughForReattach(distanceFromBottom: CGFloat) -> Bool {
        distanceFromBottom >= -leaveThreshold && distanceFromBottom <= leaveThreshold
    }
}
