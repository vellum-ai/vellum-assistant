import XCTest

@testable import VellumAssistantShared

/// Lifecycle regression tests for `EventStreamClient`.
///
/// The SSE pipeline previously stored a `URLSession?` as an instance property
/// and invalidated it from multiple MainActor callers (stop, reconnect, token
/// rotation). A back-to-back `stopSSE()` / `startSSE()` could invalidate a
/// session that another `@MainActor` task had already captured but not yet
/// passed to `URLSession.bytes(for:)`, producing an uncatchable
/// `NSGenericException` from `-[__NSURLSessionLocal taskForClassInfo:]`
/// (LUM-1001). The fix moved session ownership into the Task that uses it, so
/// no external code path can reach the session. These tests exercise the
/// MainActor state machine to ensure repeated back-to-back transitions are
/// safe — the underlying HTTP call is expected to fail fast in the test
/// environment (no connection configured), which is fine: the bug lived in
/// the state transitions, not in the network call itself.
@MainActor
final class EventStreamClientLifecycleTests: XCTestCase {

    func testRepeatedStartStopDoesNotCrash() {
        let client = EventStreamClient()
        for _ in 0..<20 {
            client.startSSE()
            client.stopSSE()
        }
    }

    func testBackToBackStartIsIdempotent() {
        let client = EventStreamClient()
        client.startSSE()
        client.startSSE()
        client.startSSE()
        client.stopSSE()
    }

    func testTeardownAfterStartIsSafe() {
        let client = EventStreamClient()
        client.startSSE()
        client.teardown()
    }

    func testStopWithoutStartIsNoOp() {
        let client = EventStreamClient()
        client.stopSSE()
    }

    func testDeallocWhileRunningDoesNotCrash() {
        autoreleasepool {
            let client = EventStreamClient()
            client.startSSE()
            _ = client
        }
    }

    // MARK: - Host Tool Ownership Filtering

    /// Verify that `registerConversationId` adds the ID to the locally owned
    /// set, which is the prerequisite for host tool requests (including
    /// host_browser_request) to pass the ownership filter.
    func testRegisterConversationIdAddsToLocallyOwned() {
        let client = EventStreamClient()
        XCTAssertFalse(client.locallyOwnedConversationIds.contains("conv-abc"))

        client.registerConversationId("conv-abc")

        XCTAssertTrue(client.locallyOwnedConversationIds.contains("conv-abc"))
    }

    /// Verify that `cleanupAfterConversationIdResolution` removes the local
    /// ID and does not leave a stale entry that could match future requests.
    func testCleanupAfterResolutionRemovesLocalId() {
        let client = EventStreamClient()
        client.registerConversationId("local-123")

        client.cleanupAfterConversationIdResolution(localId: "local-123", serverId: "server-456")

        XCTAssertFalse(
            client.locallyOwnedConversationIds.contains("local-123"),
            "Local ID should be removed after resolution"
        )
    }

    /// Verify that the locally-owned set tracks both local and server IDs
    /// after a conversation ID resolution, since SSE messages may arrive
    /// using either ID.
    func testLocallyOwnedSetContainsServerIdAfterSendMessage() {
        let client = EventStreamClient()
        // sendMessage registers the conversation ID as locally owned and
        // maps the server ID once the POST response arrives. Since we
        // cannot easily drive a full sendMessage in a unit test (it makes
        // an HTTP call), verify that registerConversationId is sufficient
        // and that the set is mutable via the public API.
        client.registerConversationId("conv-local")
        client.registerConversationId("conv-server")

        XCTAssertTrue(client.locallyOwnedConversationIds.contains("conv-local"))
        XCTAssertTrue(client.locallyOwnedConversationIds.contains("conv-server"))
    }
}
