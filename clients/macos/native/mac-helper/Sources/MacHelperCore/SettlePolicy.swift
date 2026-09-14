import Foundation

/// How long to wait for the UI to come to rest after an action, and how to
/// tell that it has. Sampling a cheap signature of the focused window lets a
/// step move on once the action's effect has landed and stopped changing.
///
/// The signature cannot see everything. Page content that re-renders without
/// changing the window title or the focused element looks identical from one
/// sample to the next, so agreement alone proves nothing. A step only ends
/// early when the signature first moved away from what it read before the
/// action and then held still. Anything else waits out the ceiling.
public enum SettlePolicy {
    /// Minimum wait after an action. Nothing is sampled before this: an app
    /// that has not started repainting yet would read as unchanged.
    public static let floorMs = 60

    /// Maximum wait, spent in full whenever the signature cannot show that the
    /// action's effect landed and came to rest.
    public static let ceilingMs = 300

    /// Gap between samples once the floor has passed.
    public static let sampleIntervalMs = 40

    /// Total budget for reading the signature before the action runs.
    public static let baselineBudgetMs = 100

    /// Settled once the signature differs from `baseline`, the reading taken
    /// before the action, and two consecutive samples agree. A nil `baseline`
    /// means no pre-action reading exists, so there is no evidence the effect
    /// landed and the step never ends early. `previous` is nil on the first
    /// sample, which can never settle.
    public static func hasSettled(baseline: String?, previous: String?, current: String) -> Bool {
        guard let baseline, current != baseline else { return false }
        return previous == current
    }

    /// Per-read AX messaging timeout, in seconds, that keeps a whole signature
    /// of `readCount` reads inside `budgetMs`, or nil when the budget is too
    /// small to be worth sampling at all.
    public static func perReadTimeoutSeconds(budgetMs: Int, readCount: Int) -> Float? {
        let minimumPerReadMs = 10
        guard readCount > 0, budgetMs >= minimumPerReadMs * readCount else { return nil }
        return Float(budgetMs / readCount) / 1000
    }
}
