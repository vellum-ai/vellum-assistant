import XCTest
@testable import VellumAssistantShared

@MainActor
final class ChatGreetingStateTests: XCTestCase {

    private final class StubConversationStarterClient: ConversationStarterClientProtocol {
        var responses: [ConversationStartersResponse?] = []
        var deleteResults: [Bool] = []
        var fetchCallCount = 0
        var deletedIds: [String] = []

        func fetchConversationStarters(limit: Int) async -> ConversationStartersResponse? {
            fetchCallCount += 1
            guard !responses.isEmpty else { return nil }
            return responses.removeFirst()
        }

        func deleteConversationStarter(id: String) async -> Bool {
            deletedIds.append(id)
            guard !deleteResults.isEmpty else { return true }
            return deleteResults.removeFirst()
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

    func testPollStopsAfterMaxIterations() async {
        let starters = [
            makeStarter(id: "s-1", label: "Starter 1"),
        ]

        let client = StubConversationStarterClient()
        // Return "refreshing" indefinitely — the cap should stop polling.
        client.responses = (0..<5).map { _ in
            ConversationStartersResponse(
                starters: starters,
                total: starters.count,
                status: "refreshing"
            )
        }

        let state = ChatGreetingState(
            conversationStarterClient: client,
            conversationStarterPollIntervalNanoseconds: 10_000_000,
            maxPollIterations: 3
        )

        state.fetchConversationStarters()

        // Wait long enough for 3 poll intervals + initial fetch
        try? await Task.sleep(nanoseconds: 200_000_000)

        // 1 initial + 3 polls = 4 fetches total (capped at 3 iterations)
        XCTAssertEqual(client.fetchCallCount, 4)
        XCTAssertFalse(state.conversationStartersLoading)
        XCTAssertEqual(state.conversationStarters.map(\.id), ["s-1"])

        state.cancelAll()
    }

    func testRemoveConversationStarterOptimisticallyDeletesAndCallsClient() async {
        let starters = [
            makeStarter(id: "starter-1", label: "Starter 1"),
            makeStarter(id: "starter-2", label: "Starter 2"),
        ]
        let client = StubConversationStarterClient()
        client.deleteResults = [true]
        let state = ChatGreetingState(conversationStarterClient: client)
        state.conversationStarters = starters

        state.removeConversationStarter(starters[0])
        await Task.yield()

        XCTAssertEqual(state.conversationStarters.map(\.id), ["starter-2"])
        XCTAssertEqual(client.deletedIds, ["starter-1"])
        XCTAssertEqual(client.fetchCallCount, 0)
    }

    func testRemoveConversationStarterRefetchesOnDeleteFailure() async {
        let staleStarters = [
            makeStarter(id: "starter-1", label: "Starter 1"),
            makeStarter(id: "starter-2", label: "Starter 2"),
        ]
        let refreshedStarters = [
            makeStarter(id: "starter-3", label: "Starter 3"),
        ]
        let client = StubConversationStarterClient()
        client.deleteResults = [false]
        client.responses = [
            ConversationStartersResponse(
                starters: refreshedStarters,
                total: refreshedStarters.count,
                status: "ready"
            ),
        ]
        let state = ChatGreetingState(conversationStarterClient: client)
        state.conversationStarters = staleStarters

        state.removeConversationStarter(staleStarters[0])
        await Task.yield()
        await Task.yield()

        XCTAssertEqual(client.deletedIds, ["starter-1"])
        XCTAssertEqual(state.conversationStarters.map(\.id), ["starter-3"])
    }
}
