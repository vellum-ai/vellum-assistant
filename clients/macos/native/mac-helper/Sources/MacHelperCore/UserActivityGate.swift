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
    /// injected into it lands inside the person's gesture. Pass `buttonHeld`
    /// and `modifierHeld` already filtered through `heldByUser`, because a
    /// button or modifier can read as held because of our own overlapping
    /// step or a flag left behind by a synthetic shortcut.
    public static func userIsActive(
        now: Date,
        lastSyntheticPostAt: Date?,
        secondsSinceLastInput: Double,
        buttonHeld: Bool = false,
        modifierHeld: Bool = false,
        syntheticSpanStart: Date? = nil,
        quietWindow: TimeInterval = 1.0,
        syntheticEpsilon: TimeInterval = 0.25
    ) -> Bool {
        if buttonHeld || modifierHeld { return true }
        guard secondsSinceLastInput <= quietWindow else { return false }
        let lastInputAt = now.addingTimeInterval(-secondsSinceLastInput)
        if let ours = lastSyntheticPostAt {
            // An AppleScript that drives System Events emits input at some
            // point while it runs, not at one known instant, so its whole run
            // counts as ours: from `syntheticSpanStart` to `lastSyntheticPostAt`.
            let start = min(syntheticSpanStart ?? ours, ours)
            if lastInputAt >= start.addingTimeInterval(-syntheticEpsilon),
               lastInputAt <= ours.addingTimeInterval(syntheticEpsilon) {
                return false
            }
        }
        return true
    }

    /// Whether an input that reads as held is the person's. Steps can overlap,
    /// so a button can be down because another step is mid-click, and a
    /// synthetic shortcut's modifier flags can outlive it. The held input
    /// counts only when the event that put it down (a button press, or a
    /// flags change, which only a physical modifier key produces) came more
    /// than `syntheticEpsilon` after our last post. An input the person
    /// already held before that post is missed, which errs toward acting
    /// rather than refusing our own next step.
    public static func heldByUser(
        now: Date,
        inputDown: Bool,
        secondsSinceLastChange: Double,
        lastSyntheticPostAt: Date?,
        syntheticEpsilon: TimeInterval = 0.25
    ) -> Bool {
        guard inputDown else { return false }
        guard let ours = lastSyntheticPostAt else { return true }
        let changedAt = now.addingTimeInterval(-secondsSinceLastChange)
        return changedAt.timeIntervalSince(ours) > syntheticEpsilon
    }
}
