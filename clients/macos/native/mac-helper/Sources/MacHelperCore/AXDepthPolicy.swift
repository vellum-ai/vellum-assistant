import Foundation

/// How deep an observation walks the accessibility tree. A full walk of a busy
/// window is the slowest part of a computer-use step, and most of what the
/// model acts on sits near the top: toolbars, sidebars, rows, form fields. So a
/// walk starts shallow, goes deeper on its own only when the shallow walk was
/// cut off and found nothing to act on, and otherwise leaves going deeper to
/// the model, which asks with `full_tree`.
public enum AXDepthPolicy {
    public static let initialDepth = 12
    public static let fullDepth = 25

    public static func startingDepth(fullTreeRequested: Bool) -> Int {
        fullTreeRequested ? fullDepth : initialDepth
    }

    /// The depth to walk again at, or nil to keep this walk.
    public static func retryDepth(after depth: Int, truncated: Bool, interactiveCount: Int) -> Int? {
        guard truncated, interactiveCount == 0, depth < fullDepth else { return nil }
        return fullDepth
    }

    /// Reads the daemon's `full_tree` input. Only a JSON boolean `true` asks
    /// for a full walk.
    public static func fullTreeRequested(from value: Any?) -> Bool {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) == CFBooleanGetTypeID()
        else { return false }
        return number.boolValue
    }
}
