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

    /**
     A window lying across the seam stands on both, but each of its controls
     stands on one. Pointing at one that is not on the shared display would
     normalise to a fraction outside 0 to 1 and draw at a clamped edge.
     */
    @Test("a control is on the display its own frame is on")
    func perControl() {
        let onBuiltIn = CGRect(x: 1300, y: 200, width: 80, height: 24)
        let onExternal = CGRect(x: 1500, y: 200, width: 80, height: 24)
        #expect(AXDisplayMatch.frame(onBuiltIn, standsOn: Self.builtIn))
        #expect(!AXDisplayMatch.frame(onBuiltIn, standsOn: Self.external))
        #expect(AXDisplayMatch.frame(onExternal, standsOn: Self.external))
        #expect(!AXDisplayMatch.frame(onExternal, standsOn: Self.builtIn))
    }

    /**
     A control lying across the seam is on both screens, but the part of it a
     caller can point at is the part on the screen being shared: its middle,
     taken from the whole frame, can be on the other monitor entirely.
     */
    @Test("what can be pointed at is the part on the display")
    func clippedToDisplay() {
        let straddling = CGRect(x: 1340, y: 200, width: 200, height: 40)
        let onBuiltIn = straddling.intersection(Self.builtIn)
        #expect(onBuiltIn == CGRect(x: 1340, y: 200, width: 100, height: 40))
        // The whole frame's middle is at x 1440, which is the other screen.
        #expect(!Self.builtIn.contains(CGPoint(x: straddling.midX, y: straddling.midY)))
        #expect(Self.builtIn.contains(CGPoint(x: onBuiltIn.midX, y: onBuiltIn.midY)))
    }

    @Test("a control with no area is on nothing")
    func noArea() {
        #expect(
            !AXDisplayMatch.frame(
                CGRect(x: 100, y: 100, width: 0, height: 0),
                standsOn: Self.builtIn
            )
        )
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
