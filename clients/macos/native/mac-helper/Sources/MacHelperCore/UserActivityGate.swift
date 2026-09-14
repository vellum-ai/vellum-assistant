import Foundation

/// Decides whether the person at the keyboard is using the machine right now,
/// so computer use can stand down instead of fighting them for the pointer.
public enum UserActivityGate {
    /// A synthetic event we posted also refreshes the system's "last input"
    /// clock, so recency alone cannot tell the user apart from us. Anything
    /// that lands within `syntheticEpsilon` of our own last post is ours.
    ///
    /// A held mouse button or modifier is activity however old the last event
    /// is: a paused drag or a held Command key sends nothing new, yet an event
    /// injected into it lands inside the person's gesture. Our own posts
    /// release every button and key before returning, so a held input is
    /// always the user's and the synthetic exclusion does not apply to it.
    public static func userIsActive(
        now: Date,
        lastSyntheticPostAt: Date?,
        secondsSinceLastInput: Double,
        buttonHeld: Bool = false,
        modifierHeld: Bool = false,
        quietWindow: TimeInterval = 1.0,
        syntheticEpsilon: TimeInterval = 0.25
    ) -> Bool {
        if buttonHeld || modifierHeld { return true }
        guard secondsSinceLastInput <= quietWindow else { return false }
        let lastInputAt = now.addingTimeInterval(-secondsSinceLastInput)
        if let ours = lastSyntheticPostAt,
           abs(lastInputAt.timeIntervalSince(ours)) <= syntheticEpsilon {
            return false
        }
        return true
    }

    /// Whether a modifier that reads as held is the person's rather than a
    /// flag left behind by a synthetic shortcut. Our key events carry modifier
    /// flags but we never post a modifier key itself, so a real press or
    /// release is the only thing that produces a flags-changed event. A held
    /// modifier counts only when its last change came after our last post.
    /// A modifier the person was already holding before that post is missed,
    /// which errs toward acting rather than refusing every step after a
    /// shortcut we sent.
    public static func modifierHeldByUser(
        now: Date,
        modifierFlagsDown: Bool,
        secondsSinceFlagsChanged: Double,
        lastSyntheticPostAt: Date?
    ) -> Bool {
        guard modifierFlagsDown else { return false }
        guard let ours = lastSyntheticPostAt else { return true }
        let flagsChangedAt = now.addingTimeInterval(-secondsSinceFlagsChanged)
        return flagsChangedAt > ours
    }
}
