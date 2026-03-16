import XCTest
@testable import VellumAssistantLib

final class CollapsedConversationSwitcherPresentationTests: XCTestCase {

    private func makeThread(id: UUID = UUID(), title: String = "Conversation") -> ConversationModel {
        ConversationModel(id: id, title: title)
    }

    // MARK: - Draft mode (no active conversation)

    func testDraftMode_withExistingThreads_showsSwitcher() {
        let conversations = [makeThread(), makeThread()]
        let sut = CollapsedConversationSwitcherPresentation(regularConversations: conversations, activeConversationId: nil)

        XCTAssertTrue(sut.showsSwitcher)
        XCTAssertEqual(sut.switchTargets.count, 2)
    }

    func testDraftMode_withNoThreads_hidesSwitcher() {
        let sut = CollapsedConversationSwitcherPresentation(regularConversations: [], activeConversationId: nil)

        XCTAssertFalse(sut.showsSwitcher)
        XCTAssertTrue(sut.switchTargets.isEmpty)
    }

    // MARK: - Active conversation

    func testActiveThread_onlyThatThread_showsSwitcherWithBadge() {
        let id = UUID()
        let conversations = [makeThread(id: id)]
        let sut = CollapsedConversationSwitcherPresentation(regularConversations: conversations, activeConversationId: id)

        XCTAssertTrue(sut.showsSwitcher)
        XCTAssertEqual(sut.totalRegularThreadCount, 1)
        XCTAssertTrue(sut.switchTargets.isEmpty)
    }

    func testActiveThread_withOtherThreads_showsSwitcherAndExcludesActive() {
        let activeId = UUID()
        let otherId = UUID()
        let conversations = [makeThread(id: activeId, title: "Active"), makeThread(id: otherId, title: "Other")]
        let sut = CollapsedConversationSwitcherPresentation(regularConversations: conversations, activeConversationId: activeId)

        XCTAssertTrue(sut.showsSwitcher)
        XCTAssertEqual(sut.switchTargets.count, 1)
        XCTAssertEqual(sut.switchTargets.first?.id, otherId)
    }

    // MARK: - Total count and badge

    func testTotalRegularThreadCount() {
        let conversations = [makeThread(), makeThread(), makeThread()]
        let sut = CollapsedConversationSwitcherPresentation(regularConversations: conversations, activeConversationId: nil)

        XCTAssertEqual(sut.totalRegularThreadCount, 3)
    }

    func testBadgeText_normalCount() {
        let conversations = [makeThread(), makeThread()]
        let sut = CollapsedConversationSwitcherPresentation(regularConversations: conversations, activeConversationId: nil)

        XCTAssertEqual(sut.badgeText, "2")
    }

    func testBadgeText_singleThread() {
        let sut = CollapsedConversationSwitcherPresentation(regularConversations: [makeThread()], activeConversationId: nil)

        XCTAssertEqual(sut.badgeText, "1")
    }

    func testBadgeText_capsAt99Plus() {
        let conversations = (0..<100).map { _ in makeThread() }
        let sut = CollapsedConversationSwitcherPresentation(regularConversations: conversations, activeConversationId: nil)

        XCTAssertEqual(sut.badgeText, "99+")
    }

    func testBadgeText_99IsNotCapped() {
        let conversations = (0..<99).map { _ in makeThread() }
        let sut = CollapsedConversationSwitcherPresentation(regularConversations: conversations, activeConversationId: nil)

        XCTAssertEqual(sut.badgeText, "99")
    }

    // MARK: - Accessibility

    func testAccessibilityLabel_withActiveThread() {
        let id = UUID()
        let conversations = [makeThread(id: id, title: "My Chat"), makeThread()]
        let sut = CollapsedConversationSwitcherPresentation(regularConversations: conversations, activeConversationId: id)

        XCTAssertEqual(sut.accessibilityLabel, "Switch conversations: My Chat")
    }

    func testAccessibilityLabel_draftMode() {
        let sut = CollapsedConversationSwitcherPresentation(regularConversations: [makeThread()], activeConversationId: nil)

        XCTAssertEqual(sut.accessibilityLabel, "Switch conversations")
    }

    func testAccessibilityValue_reflectsTotalCount() {
        let conversations = [makeThread(), makeThread(), makeThread()]
        let sut = CollapsedConversationSwitcherPresentation(regularConversations: conversations, activeConversationId: nil)

        XCTAssertEqual(sut.accessibilityValue, "3 conversations")
    }

    func testAccessibilityValue_emptyWhenNoThreads() {
        let sut = CollapsedConversationSwitcherPresentation(regularConversations: [], activeConversationId: nil)

        XCTAssertEqual(sut.accessibilityValue, "")
    }
}
