import CoreGraphics
import Testing

@testable import MacHelperCore

@Suite("AXDisplayMatch")
struct AXDisplayMatchTests {
    /// Two screens side by side, the second one to the right of the first,
    /// which is how a second monitor lands in screen points.
    private static let builtIn = CGRect(x: 0, y: 0, width: 1440, height: 900)
    private static let external = CGRect(x: 1440, y: 0, width: 1920, height: 1080)

    @Test("a tree on the display asked about stands on it")
    func onTheDisplay() {
        let frames = [
            CGRect(x: 100, y: 100, width: 600, height: 400),
            CGRect(x: 120, y: 140, width: 80, height: 24),
        ]
        #expect(AXDisplayMatch.tree(at: frames, standsOn: Self.builtIn))
    }

    @Test("a tree on the other display does not")
    func onAnotherDisplay() {
        let frames = [
            CGRect(x: 1600, y: 200, width: 600, height: 400),
            CGRect(x: 1620, y: 240, width: 80, height: 24),
        ]
        #expect(!AXDisplayMatch.tree(at: frames, standsOn: Self.builtIn))
        #expect(AXDisplayMatch.tree(at: frames, standsOn: Self.external))
    }

    @Test("a window dragged across the seam stands on both")
    func straddling() {
        let frames = [CGRect(x: 1200, y: 100, width: 600, height: 400)]
        #expect(AXDisplayMatch.tree(at: frames, standsOn: Self.builtIn))
        #expect(AXDisplayMatch.tree(at: frames, standsOn: Self.external))
    }

    @Test("a tree that says nothing about where it is is refused")
    func noGeometry() {
        #expect(!AXDisplayMatch.tree(at: [], standsOn: Self.builtIn))
        #expect(
            !AXDisplayMatch.tree(
                at: [CGRect(x: 0, y: 0, width: 0, height: 0)],
                standsOn: Self.builtIn
            )
        )
    }
}
