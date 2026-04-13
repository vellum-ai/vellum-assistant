import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Unit tests for `HomeStore` — exercised with `MockHomeStateClient` and a
/// scripted `AsyncStream<ServerMessage>` so the tests stay hermetic (no
/// network, no gateway, no daemon).
@MainActor
final class HomeStoreTests: XCTestCase {

    // MARK: - Fixtures

    private func makeRelationshipState(
        tier: Int = 2,
        progressPercent: Int = 42,
        updatedAt: String = "2026-04-13T12:00:00Z"
    ) -> RelationshipState {
        RelationshipState(
            version: 1,
            assistantId: "self",
            tier: tier,
            progressPercent: progressPercent,
            facts: [],
            capabilities: [],
            conversationCount: 3,
            hatchedDate: "2026-04-01T09:00:00Z",
            assistantName: "Vellum",
            userName: nil,
            updatedAt: updatedAt
        )
    }

    /// Creates a `HomeStore` plus its companion stream continuation so the
    /// test can drive SSE events into the store deterministically.
    private func makeStore(
        client: HomeStateClient
    ) -> (HomeStore, AsyncStream<ServerMessage>.Continuation) {
        let (stream, continuation) = AsyncStream<ServerMessage>.makeStream()
        let store = HomeStore(client: client, messageStream: stream)
        return (store, continuation)
    }

    // MARK: - Tests

    func testLoadPopulatesStateOnSuccess() async {
        let expected = makeRelationshipState(tier: 3, progressPercent: 75)
        let client = MockHomeStateClient(state: expected)
        let (store, _) = makeStore(client: client)

        XCTAssertNil(store.state, "state should start empty before load()")

        await store.load()

        XCTAssertEqual(store.state, expected)
        XCTAssertFalse(store.isLoading, "isLoading should flip back to false after load()")
        XCTAssertEqual(client.callCount, 1)
    }

    func testLoadLeavesStateUnchangedOnFailure() async {
        let seeded = makeRelationshipState(tier: 1, progressPercent: 10)
        let client = MockHomeStateClient(state: seeded)
        let (store, _) = makeStore(client: client)

        // Prime the cache with a successful load.
        await store.load()
        XCTAssertEqual(store.state, seeded)

        // Next fetch fails — store should keep the previous snapshot.
        client.setError(HomeStateClientError.httpError(statusCode: 500))
        await store.load()

        XCTAssertEqual(store.state, seeded, "state must not be blanked on transport failure")
        XCTAssertFalse(store.isLoading)
    }

    func testSSEEventTriggersReload() async throws {
        let initial = makeRelationshipState(tier: 2, progressPercent: 30, updatedAt: "2026-04-13T10:00:00Z")
        let client = MockHomeStateClient(state: initial)
        let (store, continuation) = makeStore(client: client)

        // Prime with one real fetch so we know the starting call count.
        await store.load()
        XCTAssertEqual(store.state, initial)
        let baselineCallCount = client.callCount

        // Flip the mock to the new payload and emit an SSE event.
        let updated = makeRelationshipState(tier: 3, progressPercent: 80, updatedAt: "2026-04-13T11:00:00Z")
        client.setState(updated)
        continuation.yield(.relationshipStateUpdated(updatedAt: updated.updatedAt))

        // The subscription reload is async — poll briefly on the MainActor
        // until the store observes the new state (bounded to avoid hangs).
        try await waitUntil(timeout: 2.0) {
            client.callCount > baselineCallCount && store.state == updated
        }

        XCTAssertEqual(store.state, updated)
        XCTAssertGreaterThan(client.callCount, baselineCallCount)
    }

    func testMarkSeenClearsUnseenChangesFlag() {
        let client = MockHomeStateClient(state: makeRelationshipState())
        let (store, _) = makeStore(client: client)

        // `hasUnseenChanges` starts false; `markSeen()` should keep it false
        // (idempotent) and callers in PR 16 will flip it via the producer
        // path. This test locks in the public surface for this PR.
        XCTAssertFalse(store.hasUnseenChanges)
        store.markSeen()
        XCTAssertFalse(store.hasUnseenChanges)
    }

    // MARK: - Helpers

    /// Polls `condition` on the MainActor until it returns true or the
    /// timeout elapses. Used instead of a fixed `Task.sleep` so the async
    /// subscription test finishes as soon as the reload completes.
    private func waitUntil(
        timeout: TimeInterval,
        condition: @MainActor () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try await Task.sleep(nanoseconds: 20_000_000) // 20 ms
        }
        XCTFail("waitUntil timed out after \(timeout)s")
    }
}
