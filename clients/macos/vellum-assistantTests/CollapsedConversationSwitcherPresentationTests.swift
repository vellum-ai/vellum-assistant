import XCTest
@testable import VellumAssistantLib

final class CollapsedConversationSwitcherPresentationTests: XCTestCase {

    private func makeConversation(id: UUID = UUID(), title: String = "Conversation") -> ConversationModel {
        ConversationModel(id: id, title: title)
    }

    // MARK: - Draft mode (no active conversation)

    func testDraftMode_withExistingConversations_showsSwitcher() {
        let conversations = [makeConversation(), makeConversation()]
        let sut = CollapsedConversationSwitcherPresentation(regularConversations: conversations, activeConversationId: nil)

        XCTAssertTrue(sut.showsSwitcher)
        XCTAssertEqual(sut.switchTargets.count, 2)
    }

    func testDraftMode_withNoConversations_hidesSwitcher() {
        let sut = CollapsedConversationSwitcherPresentation(regularConversations: [], activeConversationId: nil)

        XCTAssertFalse(sut.showsSwitcher)
        XCTAssertTrue(sut.switchTargets.isEmpty)
    }

    // MARK: - Active conversation

    func testActiveConversation_onlyThatConversation_showsSwitcherWithBadge() {
        let id = UUID()
        let conversations = [makeConversation(id: id)]
        let sut = CollapsedConversationSwitcherPresentation(regularConversations: conversations, activeConversationId: id)

        XCTAssertTrue(sut.showsSwitcher)
        XCTAssertEqual(sut.totalRegularConversationCount, 1)
        XCTAssertTrue(sut.switchTargets.isEmpty)
    }

    func testActiveConversation_withOtherConversations_showsSwitcherAndExcludesActive() {
        let activeId = UUID()
        let otherId = UUID()
        let conversations = [makeConversation(id: activeId, title: "Active"), makeConversation(id: otherId, title: "Other")]
        let sut = CollapsedConversationSwitcherPresentation(regularConversations: conversations, activeConversationId: activeId)

        XCTAssertTrue(sut.showsSwitcher)
        XCTAssertEqual(sut.switchTargets.count, 1)
        XCTAssertEqual(sut.switchTargets.first?.id, otherId)
    }

    // MARK: - Total count and badge

    func testTotalRegularConversationCount() {
        let conversations = [makeConversation(), makeConversation(), makeConversation()]
        let sut = CollapsedConversationSwitcherPresentation(regularConversations: conversations, activeConversationId: nil)

        XCTAssertEqual(sut.totalRegularConversationCount, 3)
    }

    func testBadgeText_normalCount() {
        let conversations = [makeConversation(), makeConversation()]
        let sut = CollapsedConversationSwitcherPresentation(regularConversations: conversations, activeConversationId: nil)

        XCTAssertEqual(sut.badgeText, "2")
    }

    func testBadgeText_singleConversation() {
        let sut = CollapsedConversationSwitcherPresentation(regularConversations: [makeConversation()], activeConversationId: nil)

        XCTAssertEqual(sut.badgeText, "1")
    }

    func testBadgeText_capsAt99Plus() {
        let conversations = (0..<100).map { _ in makeConversation() }
        let sut = CollapsedConversationSwitcherPresentation(regularConversations: conversations, activeConversationId: nil)

        XCTAssertEqual(sut.badgeText, "99+")
    }

    func testBadgeText_99IsNotCapped() {
        let conversations = (0..<99).map { _ in makeConversation() }
        let sut = CollapsedConversationSwitcherPresentation(regularConversations: conversations, activeConversationId: nil)

        XCTAssertEqual(sut.badgeText, "99")
    }

    // MARK: - Accessibility

    func testAccessibilityLabel_withActiveConversation() {
        let id = UUID()
        let conversations = [makeConversation(id: id, title: "My Chat"), makeConversation()]
        let sut = CollapsedConversationSwitcherPresentation(regularConversations: conversations, activeConversationId: id)

        XCTAssertEqual(sut.accessibilityLabel, "Switch conversations: My Chat")
    }

    func testAccessibilityLabel_draftMode() {
        let sut = CollapsedConversationSwitcherPresentation(regularConversations: [makeConversation()], activeConversationId: nil)

        XCTAssertEqual(sut.accessibilityLabel, "Switch conversations")
    }

    func testAccessibilityValue_reflectsTotalCount() {
        let conversations = [makeConversation(), makeConversation(), makeConversation()]
        let sut = CollapsedConversationSwitcherPresentation(regularConversations: conversations, activeConversationId: nil)

        XCTAssertEqual(sut.accessibilityValue, "3 conversations")
    }

    func testAccessibilityValue_emptyWhenNoConversations() {
        let sut = CollapsedConversationSwitcherPresentation(regularConversations: [], activeConversationId: nil)

        XCTAssertEqual(sut.accessibilityValue, "")
    }
}
