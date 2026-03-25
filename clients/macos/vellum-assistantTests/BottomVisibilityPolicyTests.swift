import Foundation
import Testing
@testable import VellumAssistantLib

@Suite("BottomVisibilityPolicy")
struct BottomVisibilityPolicyTests {

    @Test("enters visible state when distance ≤ enterThreshold (20pt)")
    func testEnterVisibleFromInvisible() {
        // Currently invisible — should enter visible at exactly 20pt
        #expect(BottomVisibilityPolicy.evaluate(currentlyVisible: false, distanceFromBottom: 20) == true)
        #expect(BottomVisibilityPolicy.evaluate(currentlyVisible: false, distanceFromBottom: 15) == true)
        #expect(BottomVisibilityPolicy.evaluate(currentlyVisible: false, distanceFromBottom: 0) == true)
        // Should NOT enter visible above enterThreshold
        #expect(BottomVisibilityPolicy.evaluate(currentlyVisible: false, distanceFromBottom: 21) == false)
        #expect(BottomVisibilityPolicy.evaluate(currentlyVisible: false, distanceFromBottom: 25) == false)
    }

    @Test("leaves visible state when distance > leaveThreshold (30pt)")
    func testLeaveVisibleFromVisible() {
        // Currently visible — should stay visible up to 30pt
        #expect(BottomVisibilityPolicy.evaluate(currentlyVisible: true, distanceFromBottom: 30) == true)
        #expect(BottomVisibilityPolicy.evaluate(currentlyVisible: true, distanceFromBottom: 25) == true)
        #expect(BottomVisibilityPolicy.evaluate(currentlyVisible: true, distanceFromBottom: 0) == true)
        // Should leave visible above leaveThreshold
        #expect(BottomVisibilityPolicy.evaluate(currentlyVisible: true, distanceFromBottom: 31) == false)
        #expect(BottomVisibilityPolicy.evaluate(currentlyVisible: true, distanceFromBottom: 50) == false)
    }

    @Test("hysteresis gap: state is sticky in 20-30pt band")
    func testHysteresisGap() {
        // At 25pt: if currently visible, stays visible
        #expect(BottomVisibilityPolicy.evaluate(currentlyVisible: true, distanceFromBottom: 25) == true)
        // At 25pt: if currently invisible, stays invisible
        #expect(BottomVisibilityPolicy.evaluate(currentlyVisible: false, distanceFromBottom: 25) == false)

        // At 20pt boundary: invisible → visible (enters)
        #expect(BottomVisibilityPolicy.evaluate(currentlyVisible: false, distanceFromBottom: 20) == true)
        // At 30pt boundary: visible → still visible (hasn't left yet)
        #expect(BottomVisibilityPolicy.evaluate(currentlyVisible: true, distanceFromBottom: 30) == true)
    }

    @Test("handles negative distances correctly")
    func testNegativeDistances() {
        // Negative distances within thresholds (content overscrolled past bottom)
        #expect(BottomVisibilityPolicy.evaluate(currentlyVisible: false, distanceFromBottom: -15) == true)
        #expect(BottomVisibilityPolicy.evaluate(currentlyVisible: false, distanceFromBottom: -20) == true)
        #expect(BottomVisibilityPolicy.evaluate(currentlyVisible: false, distanceFromBottom: -21) == false)
        #expect(BottomVisibilityPolicy.evaluate(currentlyVisible: true, distanceFromBottom: -25) == true)
        #expect(BottomVisibilityPolicy.evaluate(currentlyVisible: true, distanceFromBottom: -30) == true)
        #expect(BottomVisibilityPolicy.evaluate(currentlyVisible: true, distanceFromBottom: -31) == false)
    }

    @Test("boundary oscillation around 25pt causes at most 1 state change")
    func testBoundaryOscillation() {
        // Simulate rapid oscillation around 25pt starting from visible
        var isVisible = true
        var stateChanges = 0
        let distances: [CGFloat] = [25, 24, 26, 25, 23, 27, 25, 24, 26, 25]

        for distance in distances {
            let newVisible = BottomVisibilityPolicy.evaluate(
                currentlyVisible: isVisible,
                distanceFromBottom: distance
            )
            if newVisible != isVisible {
                stateChanges += 1
                isVisible = newVisible
            }
        }

        // All distances are in the 20-30pt hysteresis band, so starting from
        // visible the state should never change (stays visible the whole time).
        #expect(stateChanges <= 1)
    }

    @Test("invisible at 25pt after scrolling past 30pt: anchorIsVisible is false, isNearEnoughForReattach is true")
    func testInvisibleScrollBackTo25WhileDetached() {
        // Sequence: visible → scroll past 30 → invisible → scroll back to 25
        var isVisible = true

        // Step 1: at 0pt, visible
        isVisible = BottomVisibilityPolicy.evaluate(currentlyVisible: isVisible, distanceFromBottom: 0)
        #expect(isVisible == true)

        // Step 2: scroll past 30pt → becomes invisible
        isVisible = BottomVisibilityPolicy.evaluate(currentlyVisible: isVisible, distanceFromBottom: 35)
        #expect(isVisible == false)

        // Step 3: scroll back to 25pt — still invisible due to hysteresis
        isVisible = BottomVisibilityPolicy.evaluate(currentlyVisible: isVisible, distanceFromBottom: 25)
        #expect(isVisible == false)

        // But isNearEnoughForReattach says yes (within leaveThreshold of 30pt)
        #expect(BottomVisibilityPolicy.isNearEnoughForReattach(distanceFromBottom: 25) == true)

        // CTA condition: !isNearBottom && !anchorIsVisible → would show the button
        // (isNearBottom would be false since we haven't reattached)
        let isNearBottom = false // not reattached yet
        let ctaVisible = !isNearBottom && !isVisible
        #expect(ctaVisible == true)
    }

    @Test("after idle reattach at 25pt, CTA disappears")
    func testInvisibleScrollBackTo25ThenIdle() {
        // Setup: same as above — invisible at 25pt
        var isVisible = true
        isVisible = BottomVisibilityPolicy.evaluate(currentlyVisible: isVisible, distanceFromBottom: 0)
        isVisible = BottomVisibilityPolicy.evaluate(currentlyVisible: isVisible, distanceFromBottom: 35)
        isVisible = BottomVisibilityPolicy.evaluate(currentlyVisible: isVisible, distanceFromBottom: 25)
        #expect(isVisible == false)

        // Pre-idle state: CTA visible, reattach pending
        let preIdleIsNearBottom = false
        let preIdleCta = !preIdleIsNearBottom && !isVisible
        #expect(preIdleCta == true)
        #expect(BottomVisibilityPolicy.isNearEnoughForReattach(distanceFromBottom: 25) == true)

        // Simulate idle reattach: handleScrollToBottom() fires, sets isNearBottom = true
        // and scrolls to 0, making anchorIsVisible = true
        let postIdleIsNearBottom = true
        isVisible = BottomVisibilityPolicy.evaluate(currentlyVisible: isVisible, distanceFromBottom: 0)
        #expect(isVisible == true)

        // Post-idle state: CTA hidden
        let postIdleCta = !postIdleIsNearBottom && !isVisible
        #expect(postIdleCta == false)
    }
}
