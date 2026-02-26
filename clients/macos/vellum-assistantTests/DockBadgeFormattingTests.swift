import XCTest
@testable import VellumAssistantLib

@MainActor
final class DockBadgeFormattingTests: XCTestCase {

    private var appDelegate: AppDelegate!

    override func setUp() {
        super.setUp()
        appDelegate = AppDelegate()
    }

    override func tearDown() {
        appDelegate = nil
        super.tearDown()
    }

    func testZeroReturnsNil() {
        XCTAssertNil(appDelegate.formatDockConversationBadge(count: 0))
    }

    func testNegativeReturnsNil() {
        XCTAssertNil(appDelegate.formatDockConversationBadge(count: -1))
    }

    func testOneReturnsExactString() {
        XCTAssertEqual(appDelegate.formatDockConversationBadge(count: 1), "1")
    }

    func testNinetyNineReturnsExactString() {
        XCTAssertEqual(appDelegate.formatDockConversationBadge(count: 99), "99")
    }

    func testHundredReturnsCappedString() {
        XCTAssertEqual(appDelegate.formatDockConversationBadge(count: 100), "99+")
    }

    func testLargeNumberReturnsCappedString() {
        XCTAssertEqual(appDelegate.formatDockConversationBadge(count: 999), "99+")
    }
}
