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
}
