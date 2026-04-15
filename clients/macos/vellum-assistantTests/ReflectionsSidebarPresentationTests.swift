import XCTest
@testable import VellumAssistantLib

final class ReflectionsSidebarPresentationTests: XCTestCase {

    private func makeConversation(
        id: UUID = UUID(),
        title: String = "Conversation",
        source: String? = nil,
        lastInteractedAt: Date = Date()
    ) -> ConversationModel {
        ConversationModel(
            id: id,
            title: title,
            createdAt: lastInteractedAt,
            lastInteractedAt: lastInteractedAt,
            source: source
        )
    }

    // MARK: - Splitting conversations

    func testEmptyInput_yieldsEmptyOutputAndHidesSection() {
        let sut = ReflectionsSidebarPresentation(conversations: [])

        XCTAssertTrue(sut.mainConversations.isEmpty)
        XCTAssertTrue(sut.reflections.isEmpty)
        XCTAssertFalse(sut.showsReflectionsSection)
    }

    func testNoAutoAnalysis_allConversationsGoToMainAndHideSection() {
        let conversations = [
            makeConversation(title: "Chat 1"),
            makeConversation(title: "Chat 2", source: "user"),
            makeConversation(title: "Chat 3", source: "heartbeat"),
            makeConversation(title: "Chat 4", source: "schedule"),
        ]

        let sut = ReflectionsSidebarPresentation(conversations: conversations)

        XCTAssertEqual(sut.mainConversations.count, 4)
        XCTAssertTrue(sut.reflections.isEmpty)
        XCTAssertFalse(sut.showsReflectionsSection)
    }

    func testSingleAutoAnalysis_showsSectionWithOneRow() {
        let analysisId = UUID()
        let conversations = [
            makeConversation(title: "Chat"),
            makeConversation(id: analysisId, title: "Analysis: Chat", source: "auto-analysis"),
        ]

        let sut = ReflectionsSidebarPresentation(conversations: conversations)

        XCTAssertEqual(sut.mainConversations.count, 1)
        XCTAssertEqual(sut.mainConversations.first?.title, "Chat")
        XCTAssertEqual(sut.reflections.count, 1)
        XCTAssertEqual(sut.reflections.first?.id, analysisId)
        XCTAssertTrue(sut.showsReflectionsSection)
    }

    func testMultipleAutoAnalysis_allMoveToReflectionsOutOfMain() {
        let conversations = [
            makeConversation(title: "Chat A"),
            makeConversation(title: "Analysis: Chat A", source: "auto-analysis"),
            makeConversation(title: "Chat B"),
            makeConversation(title: "Analysis: Chat B", source: "auto-analysis"),
        ]

        let sut = ReflectionsSidebarPresentation(conversations: conversations)

        XCTAssertEqual(sut.mainConversations.map(\.title), ["Chat A", "Chat B"])
        XCTAssertEqual(sut.reflections.count, 2)
        XCTAssertTrue(sut.reflections.allSatisfy(\.isAutoAnalysisConversation))
        XCTAssertTrue(sut.showsReflectionsSection)
    }

    func testReflectionsSortedByRecencyDescending() {
        let now = Date()
        let older = makeConversation(
            title: "Older reflection",
            source: "auto-analysis",
            lastInteractedAt: now.addingTimeInterval(-3600)
        )
        let newer = makeConversation(
            title: "Newer reflection",
            source: "auto-analysis",
            lastInteractedAt: now
        )

        let sut = ReflectionsSidebarPresentation(conversations: [older, newer])

        XCTAssertEqual(sut.reflections.count, 2)
        XCTAssertEqual(sut.reflections.first?.title, "Newer reflection")
        XCTAssertEqual(sut.reflections.last?.title, "Older reflection")
    }

    func testMainConversationsPreserveInputOrder() {
        // Splitting should be order-preserving for the main list so callers that
        // rely on upstream sort order (group sort + recency) don't reshuffle.
        let a = makeConversation(title: "A")
        let b = makeConversation(title: "B")
        let c = makeConversation(title: "C")

        let sut = ReflectionsSidebarPresentation(conversations: [a, b, c])

        XCTAssertEqual(sut.mainConversations.map(\.title), ["A", "B", "C"])
    }

    // MARK: - isAutoAnalysisConversation helper

    func testIsAutoAnalysisConversation_truthyForMatchingSource() {
        let conversation = makeConversation(source: "auto-analysis")
        XCTAssertTrue(conversation.isAutoAnalysisConversation)
    }

    func testIsAutoAnalysisConversation_falsyForOtherSources() {
        XCTAssertFalse(makeConversation(source: nil).isAutoAnalysisConversation)
        XCTAssertFalse(makeConversation(source: "user").isAutoAnalysisConversation)
        XCTAssertFalse(makeConversation(source: "heartbeat").isAutoAnalysisConversation)
        XCTAssertFalse(makeConversation(source: "schedule").isAutoAnalysisConversation)
        XCTAssertFalse(makeConversation(source: "reminder").isAutoAnalysisConversation)
        XCTAssertFalse(makeConversation(source: "task").isAutoAnalysisConversation)
    }
}
