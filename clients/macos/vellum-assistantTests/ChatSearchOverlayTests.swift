import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ChatSearchOverlayTests: XCTestCase {
    func testSearchMatchesCountsEveryOccurrenceAcrossMessages() {
        let firstMessageId = UUID()
        let secondMessageId = UUID()
        let thirdMessageId = UUID()
        let messages = [
            ChatMessage(
                id: firstMessageId,
                role: .user,
                text: "app app",
                isStreaming: false
            ),
            ChatMessage(
                id: secondMessageId,
                role: .assistant,
                text: "application app",
                isStreaming: false
            ),
            ChatMessage(
                id: thirdMessageId,
                role: .assistant,
                text: "no matching text",
                isStreaming: false
            )
        ]

        let matches = ChatSearchOverlay.searchMatches(in: messages, query: "app")

        XCTAssertEqual(matches.count, 4)
        XCTAssertEqual(
            matches.map(\.messageId),
            [firstMessageId, firstMessageId, secondMessageId, secondMessageId]
        )
        XCTAssertEqual(matches.map(\.range.location), [0, 4, 0, 12])
    }

    func testOccurrenceRangesMatchHighlightSearchSemantics() {
        let ranges = ChatSearchOverlay.occurrenceRanges(
            in: "Résumé resume RESUME",
            query: "resume"
        )

        XCTAssertEqual(ranges.count, 3)
    }
}
