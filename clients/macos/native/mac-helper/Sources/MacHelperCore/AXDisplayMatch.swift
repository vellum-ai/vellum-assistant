import CoreGraphics

/// Whether what was read is on the display that was asked for.
///
/// A window names its own accessibility tree. A display does not, so the tree
/// read for a display target is whichever window is focused, and on a desk
/// with two monitors that window can be standing on the other one, or lying
/// across the seam with half its controls on each. Frames come back in screen
/// points and the caller normalises them against the display it was asked
/// about, so anything from elsewhere resolves to a fraction that lands at a
/// clamped edge or off the surface entirely.
///
/// The question is geometric because that is all it can be: nothing in the
/// tree says which screen it is on, and the frames say exactly.
public enum AXDisplayMatch {
    /// Whether something at `frame` is on `display`.
    ///
    /// Intersection rather than containment: a control half over the seam is
    /// on both screens, and it is worth pointing at from either. A frame with
    /// no area says nothing about where it is, so it is on nothing.
    public static func frame(_ frame: CGRect, standsOn display: CGRect) -> Bool {
        !frame.isEmpty && frame.intersects(display)
    }

    /// Whether a tree whose elements sit at `frames` stands on `display`.
    ///
    /// One element on it is enough. A tree with nothing on the display is a
    /// tree of some other screen, and a tree that places nothing at all
    /// cannot be shown to be on this one.
    public static func tree(at frames: [CGRect], standsOn display: CGRect) -> Bool {
        frames.contains { Self.frame($0, standsOn: display) }
    }
}
