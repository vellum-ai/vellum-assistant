import XCTest
@testable import VellumAssistantLib

final class CollapsedThreadSwitcherPresentationTests: XCTestCase {

    private func makeThread(id: UUID = UUID(), title: String = "Thread") -> ThreadModel {
        ThreadModel(id: id, title: title)
    }

    // MARK: - Draft mode (no active thread)

    func testDraftMode_withExistingThreads_showsSwitcher() {
        let threads = [makeThread(), makeThread()]
        let sut = CollapsedThreadSwitcherPresentation(regularThreads: threads, activeThreadId: nil)

        XCTAssertTrue(sut.showsSwitcher)
        XCTAssertEqual(sut.switchTargets.count, 2)
    }

    func testDraftMode_withNoThreads_hidesSwitcher() {
        let sut = CollapsedThreadSwitcherPresentation(regularThreads: [], activeThreadId: nil)

        XCTAssertFalse(sut.showsSwitcher)
        XCTAssertTrue(sut.switchTargets.isEmpty)
    }

    // MARK: - Active thread

    func testActiveThread_onlyThatThread_showsSwitcherWithBadge() {
        let id = UUID()
        let threads = [makeThread(id: id)]
        let sut = CollapsedThreadSwitcherPresentation(regularThreads: threads, activeThreadId: id)

        XCTAssertTrue(sut.showsSwitcher)
        XCTAssertEqual(sut.totalRegularThreadCount, 1)
        XCTAssertTrue(sut.switchTargets.isEmpty)
    }

    func testActiveThread_withOtherThreads_showsSwitcherAndExcludesActive() {
        let activeId = UUID()
        let otherId = UUID()
        let threads = [makeThread(id: activeId, title: "Active"), makeThread(id: otherId, title: "Other")]
        let sut = CollapsedThreadSwitcherPresentation(regularThreads: threads, activeThreadId: activeId)

        XCTAssertTrue(sut.showsSwitcher)
        XCTAssertEqual(sut.switchTargets.count, 1)
        XCTAssertEqual(sut.switchTargets.first?.id, otherId)
    }

    // MARK: - Total count and badge

    func testTotalRegularThreadCount() {
        let threads = [makeThread(), makeThread(), makeThread()]
        let sut = CollapsedThreadSwitcherPresentation(regularThreads: threads, activeThreadId: nil)

        XCTAssertEqual(sut.totalRegularThreadCount, 3)
    }

    func testBadgeText_normalCount() {
        let threads = [makeThread(), makeThread()]
        let sut = CollapsedThreadSwitcherPresentation(regularThreads: threads, activeThreadId: nil)

        XCTAssertEqual(sut.badgeText, "2")
    }

    func testBadgeText_singleThread() {
        let sut = CollapsedThreadSwitcherPresentation(regularThreads: [makeThread()], activeThreadId: nil)

        XCTAssertEqual(sut.badgeText, "1")
    }

    func testBadgeText_capsAt99Plus() {
        let threads = (0..<100).map { _ in makeThread() }
        let sut = CollapsedThreadSwitcherPresentation(regularThreads: threads, activeThreadId: nil)

        XCTAssertEqual(sut.badgeText, "99+")
    }

    func testBadgeText_99IsNotCapped() {
        let threads = (0..<99).map { _ in makeThread() }
        let sut = CollapsedThreadSwitcherPresentation(regularThreads: threads, activeThreadId: nil)

        XCTAssertEqual(sut.badgeText, "99")
    }

    // MARK: - Accessibility

    func testAccessibilityLabel_withActiveThread() {
        let id = UUID()
        let threads = [makeThread(id: id, title: "My Chat"), makeThread()]
        let sut = CollapsedThreadSwitcherPresentation(regularThreads: threads, activeThreadId: id)

        XCTAssertEqual(sut.accessibilityLabel, "Switch threads: My Chat")
    }

    func testAccessibilityLabel_draftMode() {
        let sut = CollapsedThreadSwitcherPresentation(regularThreads: [makeThread()], activeThreadId: nil)

        XCTAssertEqual(sut.accessibilityLabel, "Switch threads")
    }

    func testAccessibilityValue_reflectsTotalCount() {
        let threads = [makeThread(), makeThread(), makeThread()]
        let sut = CollapsedThreadSwitcherPresentation(regularThreads: threads, activeThreadId: nil)

        XCTAssertEqual(sut.accessibilityValue, "3 threads")
    }

    func testAccessibilityValue_emptyWhenNoThreads() {
        let sut = CollapsedThreadSwitcherPresentation(regularThreads: [], activeThreadId: nil)

        XCTAssertEqual(sut.accessibilityValue, "")
    }
}
