import SwiftUI
import XCTest
@testable import VellumAssistantShared

final class SingleSubviewLayoutCacheTests: XCTestCase {
    func testReusesMeasurementForSameProposal() {
        var cache = SingleSubviewLayoutCache()
        let proposal = ProposedViewSize(width: 320, height: nil)
        var measurementCount = 0

        let first = cache.childSize(for: proposal) {
            measurementCount += 1
            return CGSize(width: 320, height: 120)
        }
        let second = cache.childSize(for: proposal) {
            measurementCount += 1
            return CGSize(width: 320, height: 999)
        }

        XCTAssertEqual(first, CGSize(width: 320, height: 120))
        XCTAssertEqual(second, first)
        XCTAssertEqual(measurementCount, 1)
    }

    func testRemeasuresWhenProposalChanges() {
        var cache = SingleSubviewLayoutCache()
        var measurementCount = 0

        _ = cache.childSize(for: ProposedViewSize(width: 320, height: nil)) {
            measurementCount += 1
            return CGSize(width: 320, height: 120)
        }
        let changed = cache.childSize(for: ProposedViewSize(width: 480, height: nil)) {
            measurementCount += 1
            return CGSize(width: 480, height: 150)
        }

        XCTAssertEqual(changed, CGSize(width: 480, height: 150))
        XCTAssertEqual(measurementCount, 2)
    }
}
