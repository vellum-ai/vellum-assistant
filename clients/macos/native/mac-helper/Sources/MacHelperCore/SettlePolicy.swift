import Foundation

/// How long to wait for the UI to come to rest after an action, and how to
/// tell that it has. A flat wait pays the worst case on every step; sampling
/// a cheap signature of the focused window lets a fast app move on as soon as
/// it stops changing, while a slow repaint still gets the full ceiling.
public enum SettlePolicy {
    /// Minimum wait after an action. Nothing is sampled before this: an app
    /// that has not started repainting yet would read as already settled.
    public static let floorMs = 60

    /// Maximum wait, which is what the flat delay used to cost. A UI still
    /// changing at this point is observed as it is.
    public static let ceilingMs = 300

    /// Gap between samples once the floor has passed.
    public static let sampleIntervalMs = 40

    /// Settled once two consecutive samples agree. `previous` is nil on the
    /// first sample, which can never settle.
    public static func hasSettled(previous: String?, current: String) -> Bool {
        previous == current
    }
}
