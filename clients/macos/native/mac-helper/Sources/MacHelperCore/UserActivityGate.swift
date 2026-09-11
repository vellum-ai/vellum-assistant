import Foundation

/// Decides whether the person at the keyboard is using the machine right now,
/// so computer use can stand down instead of fighting them for the pointer.
public enum UserActivityGate {
    /// A synthetic event we posted also refreshes the system's "last input"
    /// clock, so recency alone cannot tell the user apart from us. Anything
    /// that lands within `syntheticEpsilon` of our own last post is ours.
    public static func userIsActive(
        now: Date,
        lastSyntheticPostAt: Date?,
        secondsSinceLastInput: Double,
        quietWindow: TimeInterval = 1.0,
        syntheticEpsilon: TimeInterval = 0.25
    ) -> Bool {
        guard secondsSinceLastInput <= quietWindow else { return false }
        let lastInputAt = now.addingTimeInterval(-secondsSinceLastInput)
        if let ours = lastSyntheticPostAt,
           abs(lastInputAt.timeIntervalSince(ours)) <= syntheticEpsilon {
            return false
        }
        return true
    }
}
