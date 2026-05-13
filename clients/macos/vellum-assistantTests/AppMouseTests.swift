// CGEventPostToPid cannot be unit-tested headlessly; runtime click behavior
// is verified manually. Tests here cover the pure coordinate-translation
// and interpolation helpers.

import CoreGraphics
import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class AppMouseTests: XCTestCase {

    // MARK: - windowRelativeToGlobal

    func test_windowRelativeToGlobal_addsWindowOriginToPoint() {
        let bounds = WindowBounds(x: 100, y: 200, width: 800, height: 600)
        let global = AppMouse.windowRelativeToGlobal(CGPoint(x: 10, y: 20), windowBounds: bounds)
        XCTAssertEqual(global.x, 110)
        XCTAssertEqual(global.y, 220)
    }

    func test_windowRelativeToGlobal_handlesNegativeWindowOrigin() {
        // Multi-monitor setups can place windows at negative origins relative
        // to the primary screen.
        let bounds = WindowBounds(x: -50, y: -100, width: 800, height: 600)
        let global = AppMouse.windowRelativeToGlobal(CGPoint(x: 10, y: 20), windowBounds: bounds)
        XCTAssertEqual(global.x, -40)
        XCTAssertEqual(global.y, -80)
    }

    // MARK: - interpolate

    func test_interpolate_returnsRequestedNumberOfPointsStrictlyBetweenEndpoints() {
        let from = CGPoint(x: 0, y: 0)
        let to = CGPoint(x: 100, y: 100)
        let points = AppMouse.interpolate(from: from, to: to, steps: 10)

        XCTAssertEqual(points.count, 10)

        for point in points {
            XCTAssertGreaterThan(point.x, from.x)
            XCTAssertLessThan(point.x, to.x)
            XCTAssertGreaterThan(point.y, from.y)
            XCTAssertLessThan(point.y, to.y)
        }

        // Evenly spaced — gap between consecutive points (and between the
        // endpoints and the first/last point) should be constant.
        let expectedStep: CGFloat = 100.0 / CGFloat(10 + 1)
        for i in 0..<points.count {
            let prevX = i == 0 ? from.x : points[i - 1].x
            XCTAssertEqual(points[i].x - prevX, expectedStep, accuracy: 0.0001)
        }
        XCTAssertEqual(to.x - points.last!.x, expectedStep, accuracy: 0.0001)
    }

    func test_interpolate_returnsEmptyForZeroOrNegativeSteps() {
        let from = CGPoint(x: 0, y: 0)
        let to = CGPoint(x: 100, y: 100)
        XCTAssertEqual(AppMouse.interpolate(from: from, to: to, steps: 0).count, 0)
        XCTAssertEqual(AppMouse.interpolate(from: from, to: to, steps: -1).count, 0)
    }

    // MARK: - MouseButton → CGMouseButton mapping

    func test_mouseButton_mapsToCGMouseButton() {
        XCTAssertEqual(AppMouse.cgButton(for: .left), .left)
        XCTAssertEqual(AppMouse.cgButton(for: .right), .right)
        // macOS represents the middle mouse button as `.center`.
        XCTAssertEqual(AppMouse.cgButton(for: .middle), .center)
    }

    func test_mouseButton_rawValuesMatchAssistantContract() {
        XCTAssertEqual(AppMouse.MouseButton.left.rawValue, "left")
        XCTAssertEqual(AppMouse.MouseButton.right.rawValue, "right")
        XCTAssertEqual(AppMouse.MouseButton.middle.rawValue, "middle")
    }
}
