import CoreGraphics

/// Whether the tree that was read is a tree of the display that was asked for.
///
/// A window names its own accessibility tree. A display does not, so the tree
/// read for a display target is whichever window is focused, and on a desk
/// with two monitors that window can be standing on the other one. Its frames
/// come back in screen points and the caller normalises them against the
/// display it was asked about, so a tree from elsewhere resolves to fractions
/// that land at a clamped edge or off the surface entirely.
///
/// The check is geometric because that is all it can be: nothing in the tree
/// says which screen it is on, and the frames say exactly.
public enum AXDisplayMatch {
    /// Whether a tree whose elements sit at `frames` stands on `display`.
    ///
    /// Intersection rather than containment: a window dragged half onto the
    /// shared screen is on it, and the controls that landed there are worth
    /// pointing at. An element with no area says nothing about where the tree
    /// is and is passed over; a tree that is all of those is refused, since a
    /// tree that cannot say where it is cannot be shown to be here.
    public static func tree(at frames: [CGRect], standsOn display: CGRect) -> Bool {
        frames.contains { !$0.isEmpty && $0.intersects(display) }
    }
}
