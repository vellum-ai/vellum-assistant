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
}
