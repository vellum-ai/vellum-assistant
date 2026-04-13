import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Unit tests for the unseen-changes producer path on `HomeStore`.
///
/// The dot on the Intelligence sidebar row is driven by four rules:
///
/// 1. The very first `load()` (cold-start) must NOT set the flag, even though
///    the SSE subscription may replay a `relationshipStateUpdated` event
///    immediately after the store is created.
/// 2. An SSE event that arrives while `isHomeTabVisible == false` MUST set
///    the flag (the user is elsewhere and deserves a nudge).
/// 3. An SSE event that arrives while `isHomeTabVisible == true` MUST leave
///    the flag alone (the user is already looking at the new state).
/// 4. `markSeen()` must clear the flag.
///
/// All four rules are locked in below with a scripted `AsyncStream` so the
/// tests are hermetic and deterministic.
@MainActor
final class HomeStoreUnseenChangesTests: XCTestCase {

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

    private func makeStore(
        client: HomeStateClient
    ) -> (HomeStore, AsyncStream<ServerMessage>.Continuation) {
        let (stream, continuation) = AsyncStream<ServerMessage>.makeStream()
        let store = HomeStore(client: client, messageStream: stream)
        return (store, continuation)
    }

    // MARK: - Tests

    /// Rule 1: cold-start `load()` must not set `hasUnseenChanges`.
    ///
    /// The dot is only ever raised by the SSE handler. A bare `load()` —
    /// whether from the foreground observer or an explicit call — never
    /// touches `hasUnseenChanges`, so the cold-start path is automatically
    /// safe as long as no SSE event arrives during it.
    func testColdLoadDoesNotSetUnseen() async {
        let expected = makeRelationshipState(tier: 3, progressPercent: 75)
        let client = MockHomeStateClient(state: expected)
        let (store, _) = makeStore(client: client)

        XCTAssertFalse(store.hasUnseenChanges, "flag should start false")

        await store.load()

        XCTAssertEqual(store.state, expected)
        XCTAssertFalse(
            store.hasUnseenChanges,
            "cold load must not light up the unseen-changes dot"
        )
    }

    /// Rule 2: SSE event while the tab is invisible must set the flag.
    ///
    /// Primes the store with a successful cold-load to anchor the baseline,
    /// then emits a `relationshipStateUpdated` event while
    /// `isHomeTabVisible == false`. The SSE handler should flip the dot on
    /// after the reload completes.
    func testEventWhileInvisibleSetsUnseen() async throws {
        let initial = makeRelationshipState(tier: 2, progressPercent: 30, updatedAt: "2026-04-13T10:00:00Z")
        let client = MockHomeStateClient(state: initial)
        let (store, continuation) = makeStore(client: client)

        // Cold-load to anchor the baseline before the SSE event arrives.
        await store.load()
        XCTAssertFalse(store.hasUnseenChanges)

        // User is elsewhere when the event arrives.
        store.isHomeTabVisible = false

        let updated = makeRelationshipState(tier: 3, progressPercent: 80, updatedAt: "2026-04-13T11:00:00Z")
        client.setState(updated)
        continuation.yield(.relationshipStateUpdated(updatedAt: updated.updatedAt))

        try await waitUntil(timeout: 2.0) {
            store.state == updated && store.hasUnseenChanges
        }

        XCTAssertEqual(store.state, updated)
        XCTAssertTrue(
            store.hasUnseenChanges,
            "off-surface event must raise the unseen-changes dot"
        )
    }

    /// Rule 3: SSE event while the tab is visible must NOT set the flag.
    ///
    /// Same setup as the previous test, except `isHomeTabVisible` is flipped
    /// to `true` before the event fires. The reload still happens (so the
    /// Home page stays fresh), but the sidebar dot must stay dark.
    func testEventWhileVisibleDoesNotSetUnseen() async throws {
        let initial = makeRelationshipState(tier: 2, progressPercent: 30, updatedAt: "2026-04-13T10:00:00Z")
        let client = MockHomeStateClient(state: initial)
        let (store, continuation) = makeStore(client: client)

        await store.load()
        XCTAssertFalse(store.hasUnseenChanges)

        // User is actively looking at the Home tab.
        store.isHomeTabVisible = true

        let updated = makeRelationshipState(tier: 3, progressPercent: 80, updatedAt: "2026-04-13T11:00:00Z")
        client.setState(updated)
        continuation.yield(.relationshipStateUpdated(updatedAt: updated.updatedAt))

        // Wait for the reload to land — we only want to observe the `state`
        // transition, not the flag (which should stay false).
        try await waitUntil(timeout: 2.0) {
            store.state == updated
        }

        // Give the SSE handler one more MainActor turn to execute the
        // post-reload visibility check (which in this case should be a
        // no-op). Without this pause we could race the producer and see
        // `state == updated` before the flag check has run.
        try await Task.sleep(nanoseconds: 50_000_000) // 50 ms

        XCTAssertEqual(store.state, updated)
        XCTAssertFalse(
            store.hasUnseenChanges,
            "on-surface event must NOT raise the unseen-changes dot"
        )
    }

    /// Rule 4: `markSeen()` clears the flag.
    ///
    /// Drives the flag high via the invisible-event path, then calls
    /// `markSeen()` and asserts the flag is cleared.
    func testMarkSeenClearsFlag() async throws {
        let initial = makeRelationshipState(tier: 2, progressPercent: 30, updatedAt: "2026-04-13T10:00:00Z")
        let client = MockHomeStateClient(state: initial)
        let (store, continuation) = makeStore(client: client)

        await store.load()
        store.isHomeTabVisible = false

        let updated = makeRelationshipState(tier: 3, progressPercent: 80, updatedAt: "2026-04-13T11:00:00Z")
        client.setState(updated)
        continuation.yield(.relationshipStateUpdated(updatedAt: updated.updatedAt))

        try await waitUntil(timeout: 2.0) {
            store.hasUnseenChanges
        }
        XCTAssertTrue(store.hasUnseenChanges)

        store.markSeen()

        XCTAssertFalse(store.hasUnseenChanges, "markSeen() must clear the dot")
    }

    // MARK: - Helpers

    /// Polls `condition` on the MainActor until it returns true or the
    /// timeout elapses. Mirrors the helper in `HomeStoreTests` so both
    /// suites share the same bounded-wait pattern.
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
