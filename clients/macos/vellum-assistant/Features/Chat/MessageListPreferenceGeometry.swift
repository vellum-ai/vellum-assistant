import Foundation

/// Decision type returned by `PreferenceGeometryFilter` indicating whether
/// a new preference value should be accepted or ignored.
enum PreferenceFilterDecision: Equatable {
    /// The new value is finite and passed dead-zone checks — apply it.
    case accept(CGFloat)
    /// The new value is non-finite (nan / inf / -inf) — keep the previous value.
    case rejectNonFinite
    /// The new value is finite but within the dead-zone threshold of the
    /// previous value — skip the update to avoid layout invalidation churn.
    case rejectDeadZone
}

/// Pure helpers for filtering scroll-geometry preference values in
/// `MessageListView`'s `onPreferenceChange` handlers.
///
/// SwiftUI's layout engine can transiently report `nan`, `inf`, or `-inf`
/// for geometry values — especially during attachment insertion, image
/// loading, and conversation switches. Treating these non-finite values as
/// real measurements causes downstream logic (bottom-pin detection, avatar
/// follower, pagination) to misbehave, potentially triggering layout
/// feedback loops that freeze the UI.
///
/// This filter centralises the finite-number gate and dead-zone suppression
/// that was previously duplicated across multiple `onPreferenceChange`
/// closures in the view body, and adds the rule that the *last known finite
/// measurement* is preserved when a non-finite value arrives.
///
/// The type is deliberately free of SwiftUI imports so it can be exercised
/// entirely through unit tests.
enum PreferenceGeometryFilter {

    /// Default dead-zone threshold in points. Preference updates whose
    /// absolute delta from the previous value is at or below this threshold
    /// are suppressed to reduce layout invalidation cascades during rapid
    /// scrolling.
    static let defaultDeadZone: CGFloat = 2

    /// Evaluate whether a new preference value should be accepted.
    ///
    /// - Parameters:
    ///   - newValue: The incoming preference value from SwiftUI's
    ///     `onPreferenceChange`.
    ///   - previous: The last accepted (stored) value. Pass `.infinity` when
    ///     no measurement has been recorded yet.
    ///   - deadZone: The minimum absolute change required for acceptance.
    ///     Pass `0` to disable dead-zone suppression (used by keys where
    ///     every finite change matters, such as `ScrollViewportHeightKey`).
    /// - Returns: A `PreferenceFilterDecision` describing whether and how
    ///   the caller should act on the new value.
    static func evaluate(
        newValue: CGFloat,
        previous: CGFloat,
        deadZone: CGFloat = defaultDeadZone
    ) -> PreferenceFilterDecision {
        // Gate 1: reject non-finite values outright.
        guard newValue.isFinite else {
            return .rejectNonFinite
        }

        // Gate 2: dead-zone suppression. When the previous value is also
        // finite, skip updates that haven't moved meaningfully.
        if deadZone > 0, previous.isFinite {
            guard abs(newValue - previous) > deadZone else {
                return .rejectDeadZone
            }
        }

        return .accept(newValue)
    }
}
