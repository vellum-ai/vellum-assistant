import CoreGraphics

/// Whether a press landed on something the assistant is pointing at.
///
/// A mark says go and press that, and the press is the one moment the user
/// has done what the step asked. The desktop sees every press; this decides
/// which of them was that one, and nothing else about it. The rectangles
/// come from the accessibility tree, in the same screen points a located
/// control is reported in, so a hit is a fact about the control rather than
/// a guess about the picture.
public enum PressWatch {
    /// Which of `rects` the press at `point` landed in, or nil for none of
    /// them.
    ///
    /// The first that contains it. Two marks can overlap when a control is
    /// pointed at inside a panel that is also ringed, and the earlier mark is
    /// the one the request listed first, which is the one the caller meant
    /// by the order it gave.
    public static func hit(_ point: CGPoint, in rects: [CGRect]) -> Int? {
        rects.firstIndex { $0.contains(point) }
    }

    /// AppKit's mouse location as the point the rectangles are measured in.
    ///
    /// AppKit reports the mouse with its origin at the bottom-left of the
    /// primary display and y growing upward; the tree, the window system
    /// Electron reads, and the rectangles all put the origin at the top-left
    /// with y growing downward. Both are global to the primary display, so
    /// the conversion is the primary's height less y, on every display.
    public static func flipped(_ point: CGPoint, primaryHeight: CGFloat) -> CGPoint {
        CGPoint(x: point.x, y: primaryHeight - point.y)
    }
}
