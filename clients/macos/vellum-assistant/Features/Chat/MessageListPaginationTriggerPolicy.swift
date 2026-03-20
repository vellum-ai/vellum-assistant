import Foundation

/// Pure helper that decides when the top-pagination sentinel should fire.
///
/// The sentinel is a zero-height view placed at the top of the `LazyVStack`
/// in `MessageListView`. SwiftUI materialises it when it enters the prefetch
/// zone — which can be **several screens above** the visible viewport — so a
/// naive `onAppear` fires long before the user has actually scrolled to the
/// top of the conversation.
///
/// This policy adds a geometric check: the sentinel's `minY` (in the scroll
/// view's coordinate space) must fall within a *trigger band* near the top of
/// the viewport. It also enforces one-shot semantics — pagination fires only
/// on the **transition** from out-of-band to in-band, preventing repeated
/// loads while the sentinel remains visible.
///
/// The type is deliberately free of SwiftUI imports so it can be exercised
/// entirely through unit tests.
enum MessageListPaginationTriggerPolicy {
    /// How far above the visible top edge (negative minY) the sentinel can be
    /// and still count as "in range". Accounts for the padding/spacing applied
    /// to the LazyVStack content.
    static let topTolerance: CGFloat = 50

    /// How far below the visible top edge the sentinel can be and still count
    /// as "in range". Covers the case where the sentinel is slightly below the
    /// top of the viewport (e.g. the user overscrolled).
    static let bottomTolerance: CGFloat = 200

    /// Returns `true` when the sentinel's `minY` falls inside the trigger band
    /// around the top of the scroll viewport.
    ///
    /// - Parameters:
    ///   - sentinelMinY: The sentinel's `minY` in the scroll view's coordinate
    ///     space. Negative values mean the sentinel is above the viewport.
    ///   - viewportHeight: The scroll view's visible height.
    /// - Returns: `true` when the sentinel is geometrically near the top.
    static func isInTriggerBand(
        sentinelMinY: CGFloat,
        viewportHeight: CGFloat
    ) -> Bool {
        guard sentinelMinY.isFinite, viewportHeight.isFinite else { return false }
        // The trigger band runs from `topTolerance` pixels above the viewport
        // top (minY = 0) to `bottomTolerance` pixels below it.
        return sentinelMinY >= -topTolerance && sentinelMinY <= bottomTolerance
    }

    /// One-shot trigger: returns `true` only on the transition from
    /// out-of-band to in-band.
    ///
    /// Callers must persist `wasInRange` across updates so the policy can
    /// detect the edge transition.
    ///
    /// - Parameters:
    ///   - sentinelMinY: The sentinel's `minY` in the scroll view's coordinate
    ///     space.
    ///   - viewportHeight: The scroll view's visible height.
    ///   - wasInRange: Whether the sentinel was inside the trigger band on the
    ///     previous geometry update.
    /// - Returns: `true` exactly once when the sentinel enters the band.
    static func shouldTrigger(
        sentinelMinY: CGFloat,
        viewportHeight: CGFloat,
        wasInRange: Bool
    ) -> Bool {
        let inRange = isInTriggerBand(sentinelMinY: sentinelMinY, viewportHeight: viewportHeight)
        // Fire only on the rising edge: was outside, now inside.
        return inRange && !wasInRange
    }
}
