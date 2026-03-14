import XCTest
@testable import VellumAssistantLib

final class SentryMaxAttachmentSizeTests: XCTestCase {
    func testSentryMaxAttachmentSizeIs100MB() {
        let expectedSize: UInt = 100 * 1024 * 1024  // 100 MB
        XCTAssertEqual(
            MetricKitManager.sentryMaxAttachmentSize,
            expectedSize,
            "Sentry maxAttachmentSize should be 100 MB to accommodate workspace file exports"
        )
    }
}
