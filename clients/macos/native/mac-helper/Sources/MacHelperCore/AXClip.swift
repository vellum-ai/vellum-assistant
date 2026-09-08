import CoreGraphics

/// What an ancestor leaves of the elements under it.
///
/// A scroll view shows a window on its contents and hides the rest, but the
/// accessibility tree reports a scrolled-away row at the frame it would have
/// if it were on screen. Read on its own that frame is a perfectly ordinary
/// place inside the window, so anything deciding where to point has to carry
/// down what each ancestor is cropping.
public enum AXClip {
    /// The rectangle left by `clip` once an ancestor at `frame` is entered.
    ///
    /// `clips` says whether that ancestor crops what is under it at all; a
    /// plain group does not, and passes its own clip through untouched. An
    /// ancestor that crops but reports no area is passed over too: a frame of
    /// nothing would hide everything beneath it, and an app answering that way
    /// is saying it does not know where the pane is rather than that the pane
    /// shows nothing.
    ///
    /// Nil is nothing cropping, which is most of a tree.
    public static func narrowed(_ clip: CGRect?, by frame: CGRect, clips: Bool) -> CGRect? {
        guard clips, !frame.isEmpty else { return clip }
        guard let clip else { return frame }
        return clip.intersection(frame)
    }
}
