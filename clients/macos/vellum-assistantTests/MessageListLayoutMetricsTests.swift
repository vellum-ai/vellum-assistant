import XCTest
@testable import VellumAssistantLib

final class MessageListLayoutMetricsTests: XCTestCase {

    func testZeroWidthFallsBackToZero() {
        let metrics = MessageListLayoutMetrics(containerWidth: 0)

        XCTAssertEqual(metrics.scrollSurfaceWidth, 0)
        XCTAssertEqual(metrics.chatColumnWidth, 0)
        XCTAssertEqual(metrics.bubbleMaxWidth, 0)
    }

    func testNarrowPaneUsesAvailableWidthForSurfaceAndColumn() {
        let metrics = MessageListLayoutMetrics(containerWidth: 640)

        XCTAssertEqual(metrics.scrollSurfaceWidth, 640)
        XCTAssertEqual(metrics.chatColumnWidth, 640)
    }

    func testWidePaneKeepsFullSurfaceAndCapsChatColumn() {
        let paneWidth = 1200.0
        let metrics = MessageListLayoutMetrics(containerWidth: paneWidth)

        XCTAssertEqual(metrics.scrollSurfaceWidth, paneWidth)
        XCTAssertLessThan(metrics.chatColumnWidth, metrics.scrollSurfaceWidth)
    }

    func testTrackedChatColumnWidthStopsChangingAfterCap() {
        let base = MessageListLayoutMetrics(containerWidth: 1200)
        let wider = MessageListLayoutMetrics(containerWidth: 1600)

        XCTAssertNotEqual(base.scrollSurfaceWidth, wider.scrollSurfaceWidth)
        XCTAssertEqual(base.chatColumnWidth, wider.chatColumnWidth)
    }
}
