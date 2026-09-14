import Foundation

/// When a computer-use observation takes its screenshot, given what the
/// daemon asked for and what the observation is scoped to.
public enum ObservationCapture: Equatable, Sendable {
    /// Capture while the accessibility walk runs, whatever the walk finds.
    case besideWalk
    /// Walk first, and capture only when the walk finds no tree, so the model
    /// is never left with neither a tree nor a picture.
    case onlyWithoutTree

    /// A window- or display-scoped observation always captures, because that
    /// picture is what it was asked for. Anything else skips the screenshot
    /// only when the daemon opted out of it.
    public static func plan(includeScreenshot: Bool, scoped: Bool) -> ObservationCapture {
        includeScreenshot || scoped ? .besideWalk : .onlyWithoutTree
    }

    /// Whether a plan that deferred its capture must take it after the walk.
    /// Only the absence of any tree forces it. Whether a tree that exists is
    /// enough to act on is the assistant's call, which it makes by asking for
    /// a screenshot.
    public func captureAfterWalk(treeFound: Bool) -> Bool {
        self == .onlyWithoutTree && !treeFound
    }

    /// Reads the daemon's `includeScreenshot` input. Only a JSON boolean
    /// `false` opts out: an absent key, or any other value, keeps the
    /// screenshot, so a daemon that never sends the flag sees no change. A
    /// number is rejected even though Foundation would bridge `0` to `false`.
    public static func includeScreenshot(from value: Any?) -> Bool {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) == CFBooleanGetTypeID()
        else { return true }
        return number.boolValue
    }
}
