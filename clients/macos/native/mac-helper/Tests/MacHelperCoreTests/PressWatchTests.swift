import CoreGraphics
import Testing

@testable import MacHelperCore

@Suite("PressWatch")
struct PressWatchTests {
    private static let share = CGRect(x: 100, y: 200, width: 80, height: 30)
    private static let export = CGRect(x: 300, y: 200, width: 80, height: 30)

    @Test("a press inside a rectangle names it")
    func hit() {
        #expect(PressWatch.hit(CGPoint(x: 140, y: 215), in: [Self.share, Self.export]) == 0)
        #expect(PressWatch.hit(CGPoint(x: 340, y: 215), in: [Self.share, Self.export]) == 1)
    }

    @Test("a press outside every rectangle names none")
    func miss() {
        #expect(PressWatch.hit(CGPoint(x: 240, y: 215), in: [Self.share, Self.export]) == nil)
        #expect(PressWatch.hit(CGPoint(x: 140, y: 215), in: []) == nil)
    }

    /// A control pointed at inside a panel that is also ringed: the request
    /// listed the control first, so the press is the control's.
    @Test("overlapping rectangles go to the one listed first")
    func overlap() {
        let panel = CGRect(x: 0, y: 0, width: 500, height: 500)
        #expect(PressWatch.hit(CGPoint(x: 140, y: 215), in: [Self.share, panel]) == 0)
        #expect(PressWatch.hit(CGPoint(x: 140, y: 215), in: [panel, Self.share]) == 0)
    }

    /// AppKit puts the origin at the bottom-left of the primary display. A
    /// press 10 points below the top of a 900-point display is at y 890 to
    /// AppKit and y 10 to everything the rectangles come from.
    @Test("the mouse location is flipped into top-left coordinates")
    func flip() {
        #expect(
            PressWatch.flipped(CGPoint(x: 140, y: 890), primaryHeight: 900)
                == CGPoint(x: 140, y: 10)
        )
        // A display below the primary is at negative y to AppKit and past
        // the primary's height to the rectangles.
        #expect(
            PressWatch.flipped(CGPoint(x: 140, y: -100), primaryHeight: 900)
                == CGPoint(x: 140, y: 1000)
        )
    }
}
