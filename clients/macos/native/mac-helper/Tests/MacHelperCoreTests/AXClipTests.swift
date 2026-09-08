import CoreGraphics
import Testing

@testable import MacHelperCore

@Suite("AXClip")
struct AXClipTests {
    /// A pane showing part of a long list, and a row scrolled above it that
    /// the tree still reports at the frame it would have on screen.
    private static let pane = CGRect(x: 100, y: 200, width: 400, height: 300)
    private static let scrolledAwayRow = CGRect(x: 110, y: 120, width: 380, height: 30)
    private static let visibleRow = CGRect(x: 110, y: 260, width: 380, height: 30)

    @Test("an ancestor that does not crop passes its own clip through")
    func passthrough() {
        #expect(AXClip.narrowed(nil, by: Self.pane, clips: false) == nil)
        #expect(
            AXClip.narrowed(Self.pane, by: CGRect(x: 0, y: 0, width: 50, height: 50), clips: false)
                == Self.pane
        )
    }

    @Test("a cropping ancestor becomes the clip")
    func firstClip() {
        #expect(AXClip.narrowed(nil, by: Self.pane, clips: true) == Self.pane)
    }

    @Test("a cropping ancestor inside another leaves the overlap")
    func nested() {
        let inner = CGRect(x: 300, y: 200, width: 400, height: 300)
        #expect(
            AXClip.narrowed(Self.pane, by: inner, clips: true)
                == CGRect(x: 300, y: 200, width: 200, height: 300)
        )
    }

    /// A collapsed pane keeps its rows at the frames they had while it was
    /// open, so a pane reporting no area is a pane showing none of them.
    @Test("a cropping ancestor with no area leaves nothing")
    func noArea() {
        #expect(AXClip.narrowed(Self.pane, by: .zero, clips: true)!.isEmpty)
        #expect(AXClip.narrowed(nil, by: .zero, clips: true)!.isEmpty)
        let collapsed = AXClip.narrowed(nil, by: .zero, clips: true)!
        #expect(!AXDisplayMatch.frame(Self.visibleRow, standsOn: collapsed))
    }

    /// The point of carrying the clip down: a row above the pane reads as an
    /// ordinary place inside the window until it is measured against what the
    /// pane leaves.
    @Test("a scrolled-away row is not where the pane can be seen")
    func scrolledAway() {
        let visible = AXClip.narrowed(nil, by: Self.pane, clips: true)!
        #expect(!AXDisplayMatch.frame(Self.scrolledAwayRow, standsOn: visible))
        #expect(AXDisplayMatch.frame(Self.visibleRow, standsOn: visible))
    }
}
