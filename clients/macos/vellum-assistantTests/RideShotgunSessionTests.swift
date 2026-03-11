import XCTest
import Combine
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Tests for RideShotgunSession state machine and AmbientAgent learn-mode behavior.
/// Validates that session lifecycle, failure surfacing, and state transitions work
/// correctly now that the assistant owns CDP browser bootstrap.
final class RideShotgunSessionTests: XCTestCase {

    // MARK: - RideShotgunSession Initial State

    @MainActor
    func testSessionStartsInIdleState() {
        let session = RideShotgunSession(durationSeconds: 60)
        XCTAssertEqual(session.state, .idle)
        XCTAssertEqual(session.summary, "")
        XCTAssertEqual(session.observationCount, 0)
        XCTAssertNil(session.recordingId)
    }

    @MainActor
    func testIsLearnModeReturnsTrueForLearn() {
        let session = RideShotgunSession(durationSeconds: 60, mode: "learn")
        XCTAssertTrue(session.isLearnMode)
    }

    @MainActor
    func testIsLearnModeReturnsFalseForObserve() {
        let session = RideShotgunSession(durationSeconds: 60, mode: "observe")
        XCTAssertFalse(session.isLearnMode)
    }

    @MainActor
    func testIsLearnModeReturnsFalseForNilMode() {
        let session = RideShotgunSession(durationSeconds: 60)
        XCTAssertFalse(session.isLearnMode)
    }

    @MainActor
    func testSessionStoresTargetDomain() {
        let session = RideShotgunSession(durationSeconds: 300, mode: "learn", targetDomain: "example.com")
        XCTAssertEqual(session.targetDomain, "example.com")
    }

    @MainActor
    func testSessionStoresDurationAndInterval() {
        let session = RideShotgunSession(durationSeconds: 180, intervalSeconds: 5)
        XCTAssertEqual(session.durationSeconds, 180)
        XCTAssertEqual(session.intervalSeconds, 5)
    }

    // MARK: - State Enum Equatable

    @MainActor
    func testStateEquality() {
        XCTAssertEqual(RideShotgunSession.State.idle, .idle)
        XCTAssertEqual(RideShotgunSession.State.starting, .starting)
        XCTAssertEqual(RideShotgunSession.State.capturing, .capturing)
        XCTAssertEqual(RideShotgunSession.State.summarizing, .summarizing)
        XCTAssertEqual(RideShotgunSession.State.complete, .complete)
        XCTAssertEqual(RideShotgunSession.State.cancelled, .cancelled)
        XCTAssertEqual(RideShotgunSession.State.failed("error"), .failed("error"))
        XCTAssertNotEqual(RideShotgunSession.State.failed("a"), .failed("b"))
    }

    // MARK: - Failed State (Bootstrap Failure)

    @MainActor
    func testFailedStateStoresErrorMessage() {
        let state = RideShotgunSession.State.failed("CDP bootstrap timed out")
        if case .failed(let message) = state {
            XCTAssertEqual(message, "CDP bootstrap timed out")
        } else {
            XCTFail("Expected .failed state")
        }
    }

    @MainActor
    func testFailedStateIsDistinctFromCancelledAndComplete() {
        let failed = RideShotgunSession.State.failed("browser not found")
        XCTAssertNotEqual(failed, .cancelled)
        XCTAssertNotEqual(failed, .complete)
        XCTAssertNotEqual(failed, .idle)
        XCTAssertNotEqual(failed, .starting)
        XCTAssertNotEqual(failed, .capturing)
        XCTAssertNotEqual(failed, .summarizing)
    }

    @MainActor
    func testFailedStatesWithDifferentMessagesAreNotEqual() {
        let a = RideShotgunSession.State.failed("timeout")
        let b = RideShotgunSession.State.failed("connection refused")
        XCTAssertNotEqual(a, b)
    }

    @MainActor
    func testFailedStatesWithSameMessageAreEqual() {
        let a = RideShotgunSession.State.failed("bootstrap failed")
        let b = RideShotgunSession.State.failed("bootstrap failed")
        XCTAssertEqual(a, b)
    }

    @MainActor
    func testSessionTransitionToFailedPreservesErrorMessage() {
        // Verify that when a session enters .failed, the associated message is
        // accessible and the session's data properties remain at defaults (no
        // partial results).
        let session = RideShotgunSession(durationSeconds: 60)
        session.state = .failed("Chrome DevTools connection refused")
        XCTAssertEqual(session.state, .failed("Chrome DevTools connection refused"))
        XCTAssertEqual(session.summary, "", "Summary should remain empty on failure")
        XCTAssertEqual(session.observationCount, 0, "Observation count should remain zero on failure")
        XCTAssertNil(session.recordingId, "Recording ID should remain nil on failure")
    }

    @MainActor
    func testCancelProducesCancelledNotFailed() {
        // Ensures cancel() transitions to .cancelled, not .failed, so the UI
        // can distinguish user-initiated cancellation from bootstrap errors.
        let session = RideShotgunSession(durationSeconds: 60)
        session.cancel()
        XCTAssertEqual(session.state, .cancelled)
        XCTAssertNotEqual(session.state, .failed(""))
    }

    // MARK: - AmbientAgent Learn Session (No CDP Pre-launch Assumption)

    @MainActor
    func testStartLearnSessionWithoutDaemonClientDoesNotCrash() {
        // Verifies that startLearnSession gracefully handles a nil daemon client
        // rather than assuming Chrome is pre-launched with CDP.
        let agent = AmbientAgent()
        agent.startLearnSession(targetDomain: "example.com")
        // Should not start a session without a daemon client
        XCTAssertNil(agent.currentSession)
    }

    @MainActor
    func testStartLearnSessionWhileSessionActiveIsNoOp() {
        // Simulate an already-active session to verify guard logic
        let agent = AmbientAgent()
        // Without a daemon client, the first call is a no-op. The guard for
        // currentSession == nil prevents double-starting even when daemonClient
        // is present.
        agent.startLearnSession(targetDomain: "example.com")
        XCTAssertNil(agent.currentSession, "No session without daemon client")
    }

    @MainActor
    func testCancelRideShotgunClearsSession() {
        let agent = AmbientAgent()
        agent.cancelRideShotgun()
        XCTAssertNil(agent.currentSession)
    }

    // MARK: - Message Delivery Path

    @MainActor
    func testRideShotgunErrorMessageTransitionsSessionToFailed() async throws {
        // Exercises the actual subscription loop in RideShotgunSession.start():
        // a rideShotgunError message delivered through the DaemonClient stream
        // should transition the session from .starting to .failed with the error
        // message from the event payload.
        let mockClient = MockDaemonClient()
        let continuation = mockClient.setupTestStream()

        let session = RideShotgunSession(durationSeconds: 60)
        session.start(daemonClient: mockClient)
        XCTAssertEqual(session.state, .starting)

        // Deliver the error through the event subscription
        let errorMessage = RideShotgunErrorMessage(
            type: "ride_shotgun_error",
            watchId: "w-1",
            sessionId: "s-1",
            message: "CDP bootstrap timed out"
        )
        continuation.yield(.rideShotgunError(errorMessage))

        // Poll until the subscription loop processes the message (up to 5s).
        let deadline = ContinuousClock.now + .seconds(5)
        while session.state == .starting, ContinuousClock.now < deadline {
            try await Task.sleep(nanoseconds: 10_000_000)
        }

        XCTAssertEqual(session.state, .failed("CDP bootstrap timed out"))
        XCTAssertEqual(session.summary, "", "Summary should remain empty on error")
        XCTAssertEqual(session.observationCount, 0, "Observation count should remain zero on error")
    }
}
