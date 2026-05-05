import XCTest
@testable import VellumAssistantShared

final class VSliderTests: XCTestCase {
    func testSnappingIsRelativeToLowerBound() {
        XCTAssertEqual(
            VSlider.snappedValue(5.6, in: 1...10, step: 3),
            7
        )
        XCTAssertEqual(
            VSlider.snappedValue(2.4, in: 1...10, step: 3),
            1
        )
    }

    func testTickValuesStartAtLowerBound() {
        XCTAssertEqual(
            VSlider.tickValues(in: 1...10, step: 3),
            [1, 4, 7, 10]
        )
    }
}
