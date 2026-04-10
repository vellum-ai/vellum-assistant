import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class MessageListProjectionCacheTests: XCTestCase {
    func testMessageRevisionInvalidatesProjectionCacheForStreamingTextGrowth() {
        let messageId = UUID()
        let cache = ProjectionCache()

        // Initial projection with "Hello".
        let initialMessages = [
            ChatMessage(
                id: messageId,
                role: .assistant,
                text: "Hello",
                isStreaming: true
            )
        ]
        cache.lastKnownMessagesRevision = 0
        cache.messageListVersion = 0

        // Simulate revision bump (messagesRevision changed from 0 → 1).
        let revision1: UInt64 = 1
        if cache.lastKnownMessagesRevision != revision1 {
            cache.messageListVersion += 1
            cache.lastKnownMessagesRevision = revision1
        }
        XCTAssertEqual(cache.messageListVersion, 1)

        let initialProjection = TranscriptProjector.project(
            messages: initialMessages,
            paginatedVisibleMessages: initialMessages,
            activeSubagents: [],
            isSending: true,
            isThinking: false,
            isCompacting: false,
            assistantStatusText: nil,
            assistantActivityPhase: "streaming",
            assistantActivityAnchor: "assistant_turn",
            assistantActivityReason: nil,
            activePendingRequestId: nil,
            highlightedMessageId: nil
        )
        cache.cachedProjection = initialProjection
        XCTAssertEqual(initialProjection.rows.last?.message.text, "Hello")

        // Simulate streaming: text grows to "Hello, world".
        let updatedMessages = [
            ChatMessage(
                id: messageId,
                role: .assistant,
                text: "Hello, world",
                isStreaming: true
            )
        ]
        let revision2: UInt64 = 2
        if cache.lastKnownMessagesRevision != revision2 {
            cache.messageListVersion += 1
            cache.lastKnownMessagesRevision = revision2
        }
        XCTAssertEqual(cache.messageListVersion, 2)

        let updatedProjection = TranscriptProjector.project(
            messages: updatedMessages,
            paginatedVisibleMessages: updatedMessages,
            activeSubagents: [],
            isSending: true,
            isThinking: false,
            isCompacting: false,
            assistantStatusText: nil,
            assistantActivityPhase: "streaming",
            assistantActivityAnchor: "assistant_turn",
            assistantActivityReason: nil,
            activePendingRequestId: nil,
            highlightedMessageId: nil
        )
        cache.cachedProjection = updatedProjection
        XCTAssertEqual(updatedProjection.rows.last?.message.text, "Hello, world")
    }
}
