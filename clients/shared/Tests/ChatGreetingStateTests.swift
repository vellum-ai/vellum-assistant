import XCTest
@testable import VellumAssistantShared

@MainActor
final class ChatGreetingStateTests: XCTestCase {

    private final class StubConversationStarterClient: ConversationStarterClientProtocol {
        var responses: [ConversationStartersResponse?] = []
        var fetchCallCount = 0

        func fetchConversationStarters(limit: Int) async -> ConversationStartersResponse? {
            fetchCallCount += 1
            guard !responses.isEmpty else { return nil }
            return responses.removeFirst()
        }
    }

    private func makeStarter(id: String, label: String) -> ConversationStarter {
        ConversationStarter(
            id: id,
            label: label,
            prompt: "prompt for \(label)",
            category: "productivity",
            batch: 1
        )
    }

    func testRefreshingResponseKeepsExistingStartersVisibleAndPollsUntilReady() async {
        let staleStarters = [
            makeStarter(id: "old-1", label: "Old starter 1"),
            makeStarter(id: "old-2", label: "Old starter 2"),
        ]
        let freshStarters = [
            makeStarter(id: "new-1", label: "New starter 1"),
            makeStarter(id: "new-2", label: "New starter 2"),
        ]

        let client = StubConversationStarterClient()
        client.responses = [
            ConversationStartersResponse(
                starters: staleStarters,
                total: staleStarters.count,
                status: "refreshing"
            ),
            ConversationStartersResponse(
                starters: freshStarters,
                total: freshStarters.count,
                status: "ready"
            ),
        ]

        let state = ChatGreetingState(
            conversationStarterClient: client,
            conversationStarterPollIntervalNanoseconds: 50_000_000
        )

        state.fetchConversationStarters()
        await Task.yield()
        await Task.yield()

        XCTAssertEqual(state.conversationStarters.map(\.id), ["old-1", "old-2"])
        XCTAssertTrue(state.conversationStartersLoading)
        XCTAssertEqual(client.fetchCallCount, 1)

        try? await Task.sleep(nanoseconds: 80_000_000)

        XCTAssertEqual(state.conversationStarters.map(\.id), ["new-1", "new-2"])
        XCTAssertFalse(state.conversationStartersLoading)
        XCTAssertEqual(client.fetchCallCount, 2)

        state.cancelAll()
    }
}
