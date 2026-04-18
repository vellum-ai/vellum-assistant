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
}
