import XCTest
@testable import VellumAssistantShared

final class AuthFailureTrackerTests: XCTestCase {
    /// Helper that exposes a mutable `Date` the tracker reads via its injected clock.
    private final class Clock {
        var now: Date
        init(_ start: Date = Date(timeIntervalSince1970: 1_700_000_000)) {
            self.now = start
        }
        func advance(_ seconds: TimeInterval) {
            now = now.addingTimeInterval(seconds)
        }
    }

    private func makeTracker(
        windowSeconds: TimeInterval = 30,
        minFailures: Int = 4,
        clock: Clock
    ) -> AuthFailureTracker {
        AuthFailureTracker(
            windowSeconds: windowSeconds,
            minFailures: minFailures,
            now: { clock.now }
        )
    }

    /// (a) A single 401 does NOT trip `isAuthFailed`.
    func testSingleFailureDoesNotTrip() {
        let clock = Clock()
        let tracker = makeTracker(clock: clock)

        tracker.recordFailure(statusCode: 401, path: "/api/ping")

        XCTAssertFalse(tracker.isAuthFailed)
        XCTAssertEqual(tracker.lastStatusCode, 401)
        XCTAssertEqual(tracker.lastPath, "/api/ping")
    }

    /// (b) `minFailures` 401s inside the window DOES trip it.
    func testMinFailuresInWindowTrips() {
        let clock = Clock()
        let tracker = makeTracker(clock: clock)

        for _ in 0..<4 {
            tracker.recordFailure(statusCode: 401, path: "/api/ping")
            clock.advance(1)
        }

        XCTAssertTrue(tracker.isAuthFailed)
    }

    /// (c) Failures outside the window are pruned and do not count.
    func testFailuresOutsideWindowArePruned() {
        let clock = Clock()
        let tracker = makeTracker(windowSeconds: 30, minFailures: 4, clock: clock)

        // Three old failures that will fall outside the window.
        for _ in 0..<3 {
            tracker.recordFailure(statusCode: 401, path: "/api/old")
            clock.advance(1)
        }

        // Jump past the window.
        clock.advance(60)

        // One new failure inside the current window.
        tracker.recordFailure(statusCode: 401, path: "/api/new")

        // Only one live entry -> not tripped, even though we've recorded 4 total.
        XCTAssertFalse(tracker.isAuthFailed)
    }

    /// (d) A 500 or 404 does not accumulate.
    func testNonAuthStatusCodesDoNotAccumulate() {
        let clock = Clock()
        let tracker = makeTracker(clock: clock)

        for code in [500, 404, 502, 403, 400, 418] {
            tracker.recordFailure(statusCode: code, path: "/api/other")
            clock.advance(1)
        }

        XCTAssertFalse(tracker.isAuthFailed)
        // lastStatusCode / lastPath should remain nil because nothing was recorded.
        XCTAssertNil(tracker.lastStatusCode)
        XCTAssertNil(tracker.lastPath)
    }

    /// (e) `recordSuccess()` resets the tracker back to `isAuthFailed == false` immediately.
    func testRecordSuccessResetsTracker() {
        let clock = Clock()
        let tracker = makeTracker(clock: clock)

        for _ in 0..<4 {
            tracker.recordFailure(statusCode: 401, path: "/api/ping")
            clock.advance(1)
        }
        XCTAssertTrue(tracker.isAuthFailed)

        tracker.recordSuccess()

        XCTAssertFalse(tracker.isAuthFailed)
    }

    /// (f) `429` counts the same as `401`.
    func test429CountsSameAs401() {
        let clock = Clock()
        let tracker = makeTracker(clock: clock)

        for _ in 0..<4 {
            tracker.recordFailure(statusCode: 429, path: "/api/ping")
            clock.advance(1)
        }

        XCTAssertTrue(tracker.isAuthFailed)
        XCTAssertEqual(tracker.lastStatusCode, 429)
    }
}
