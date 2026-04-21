import XCTest
@testable import VellumAssistantShared

/// Unit tests for the `isAuthFailed` signal on `GatewayConnectionManager`.
///
/// Rather than stand up a `URLProtocol` fake, these tests drive the same
/// internal code path that `performHealthCheck()` uses when an HTTP outcome
/// is decoded. See the `_testIngestHealthStatus` hook on GCM.
@MainActor
final class GatewayConnectionManagerAuthTests: XCTestCase {

    // MARK: - Sustained failures trip the signal

    func testFourSequential401sTripsIsAuthFailed() {
        let gcm = GatewayConnectionManager()
        XCTAssertFalse(gcm.isAuthFailed, "Fresh GCM should not be in auth-failed state")

        for _ in 0..<4 {
            gcm._testIngestHealthStatus(401)
        }

        XCTAssertTrue(gcm.isAuthFailed, "Four sequential 401s should trip isAuthFailed")
    }

    // MARK: - 200 after trip clears the signal

    func testSuccessAfterTripClearsIsAuthFailed() {
        let gcm = GatewayConnectionManager()

        for _ in 0..<4 {
            gcm._testIngestHealthStatus(401)
        }
        XCTAssertTrue(gcm.isAuthFailed)

        gcm._testIngestHealthStatus(200)

        XCTAssertFalse(gcm.isAuthFailed, "A 200 after trip should clear isAuthFailed")
    }

    // MARK: - A single 401 followed by 200 never trips

    func testSingle401ThenSuccessNeverTrips() {
        let gcm = GatewayConnectionManager()

        gcm._testIngestHealthStatus(401)
        XCTAssertFalse(gcm.isAuthFailed, "One 401 alone must not trip")

        gcm._testIngestHealthStatus(200)
        XCTAssertFalse(gcm.isAuthFailed, "200 after a single 401 must leave isAuthFailed false")
    }

    // MARK: - attemptRePair clears isAuthFailed on successful bootstrap

    func testAttemptRePairClearsIsAuthFailedOnSuccess() async {
        let gcm = GatewayConnectionManager()

        for _ in 0..<4 {
            gcm._testIngestHealthStatus(401)
        }
        XCTAssertTrue(gcm.isAuthFailed, "Four 401s should trip isAuthFailed before re-pair")

        await gcm.attemptRePair(bootstrap: {
            // Successful fake bootstrap — no-op.
        })

        XCTAssertFalse(gcm.isAuthFailed, "Successful re-pair should flip isAuthFailed back to false")
    }

    // MARK: - Overlapping attemptRePair calls coalesce

    func testOverlappingAttemptRePairCallsCoalesce() async {
        let gcm = GatewayConnectionManager()

        // Actor-safe counter for concurrent increments.
        actor Counter {
            var value = 0
            func increment() { value += 1 }
            func read() -> Int { value }
        }
        let counter = Counter()

        // A bootstrap that suspends long enough for a second call to observe
        // `isAttemptingRePair == true` and bail out.
        let bootstrap: @MainActor @Sendable () async throws -> Void = {
            await counter.increment()
            try? await Task.sleep(nanoseconds: 50_000_000) // 50ms
        }

        async let first: Void = gcm.attemptRePair(bootstrap: bootstrap)
        async let second: Void = gcm.attemptRePair(bootstrap: bootstrap)
        _ = await (first, second)

        let invocations = await counter.read()
        XCTAssertEqual(invocations, 1, "Overlapping attemptRePair calls should coalesce to a single bootstrap invocation")
    }

    // MARK: - attemptRePair bounds the bootstrap with a timeout

    /// Regression test for the `attemptRePair` latch bug: if the injected
    /// bootstrap hangs indefinitely (offline network, stuck guardian poll,
    /// etc.) the method must still release the `isAttemptingRePair` guard
    /// within the timeout budget so subsequent clicks aren't silently
    /// dropped with "already in flight — skipping". We use a 100ms timeout
    /// here to keep the test fast.
    func testAttemptRePairTimesOutWhenBootstrapHangs() async {
        let gcm = GatewayConnectionManager()

        // A bootstrap that effectively never returns on the test's timescale.
        let hangingBootstrap: @MainActor @Sendable () async throws -> Void = {
            try await Task.sleep(nanoseconds: 500_000_000_000) // 500s
        }

        let start = Date()
        await gcm.attemptRePair(bootstrap: hangingBootstrap, timeout: 0.1)
        let elapsed = Date().timeIntervalSince(start)

        XCTAssertLessThan(elapsed, 5.0, "attemptRePair must return well before the hanging bootstrap completes")

        // A follow-up call must be able to run — i.e. the latch was released.
        actor Invoked { var value = false; func mark() { value = true }; func read() -> Bool { value } }
        let invoked = Invoked()
        await gcm.attemptRePair(bootstrap: {
            await invoked.mark()
        }, timeout: 1.0)
        let didInvoke = await invoked.read()
        XCTAssertTrue(didInvoke, "After a timeout, a subsequent attemptRePair must not be short-circuited by the stuck latch")
    }

    // MARK: - disconnect() clears isAuthFailed

    /// Regression test for the stale `isAuthFailed` bug: `disconnect()` /
    /// `disconnectInternal()` must reset the auth-failed state so a
    /// subsequent reconnect does not inherit a stale trip from the previous
    /// session (e.g. the managed-404 teardown path, or an explicit
    /// `disconnect()` call from the app).
    func testDisconnectClearsIsAuthFailed() {
        let gcm = GatewayConnectionManager()

        for _ in 0..<4 {
            gcm._testIngestHealthStatus(401)
        }
        XCTAssertTrue(gcm.isAuthFailed, "Four 401s should trip isAuthFailed before disconnect")

        gcm.disconnect()

        XCTAssertFalse(gcm.isAuthFailed, "disconnect() must clear isAuthFailed so reconnect starts clean")
    }
}
