import XCTest
@testable import VellumAssistantLib

/// Exercises the throttle bookkeeping on `ScrollWheelDetector.Coordinator`,
/// proving that retether and untether diagnostics stay rate-limited per
/// detector instance.
@MainActor
final class ScrollWheelDetectorCoordinatorTests: XCTestCase {

    // MARK: - Helpers

    /// Creates a fresh coordinator for testing.
    private func makeCoordinator() -> ScrollWheelDetector.Coordinator {
        ScrollWheelDetector.Coordinator()
    }

    // MARK: - Throttle Interval

    func testThrottleIntervalIsHalfSecond() {
        // The throttle interval is a public static so instrumentation and tests
        // can reference the same constant.
        XCTAssertEqual(
            ScrollWheelDetector.Coordinator.diagnosticThrottleInterval,
            0.5,
            "Throttle interval should be 0.5 seconds"
        )
    }

    // MARK: - First Call Always Passes

    func testFirstUntetherCallIsAllowed() {
        let coordinator = makeCoordinator()
        XCTAssertTrue(
            coordinator.shouldRecordDiagnostic(kind: .scrollWheelUntether),
            "First untether diagnostic should always be recorded"
        )
    }

    func testFirstRetetherCallIsAllowed() {
        let coordinator = makeCoordinator()
        XCTAssertTrue(
            coordinator.shouldRecordDiagnostic(kind: .scrollWheelRetether),
            "First retether diagnostic should always be recorded"
        )
    }

    // MARK: - Rapid Successive Calls Are Throttled

    func testRapidUntetherCallsAreThrottled() {
        let coordinator = makeCoordinator()

        // First call passes.
        let first = coordinator.shouldRecordDiagnostic(kind: .scrollWheelUntether)
        XCTAssertTrue(first)

        // Immediate second call should be throttled (< 0.5s has elapsed).
        let second = coordinator.shouldRecordDiagnostic(kind: .scrollWheelUntether)
        XCTAssertFalse(second, "Rapid untether call should be throttled")
    }

    func testRapidRetetherCallsAreThrottled() {
        let coordinator = makeCoordinator()

        let first = coordinator.shouldRecordDiagnostic(kind: .scrollWheelRetether)
        XCTAssertTrue(first)

        let second = coordinator.shouldRecordDiagnostic(kind: .scrollWheelRetether)
        XCTAssertFalse(second, "Rapid retether call should be throttled")
    }

    // MARK: - Independent Throttle Per Kind

    func testUntetherAndRetetherThrottleIndependently() {
        let coordinator = makeCoordinator()

        // Record one untether — passes.
        XCTAssertTrue(coordinator.shouldRecordDiagnostic(kind: .scrollWheelUntether))

        // Immediately record a retether — should also pass (different kind).
        XCTAssertTrue(
            coordinator.shouldRecordDiagnostic(kind: .scrollWheelRetether),
            "Retether throttle should be independent of untether"
        )

        // Rapid second untether — throttled.
        XCTAssertFalse(coordinator.shouldRecordDiagnostic(kind: .scrollWheelUntether))

        // Rapid second retether — throttled.
        XCTAssertFalse(coordinator.shouldRecordDiagnostic(kind: .scrollWheelRetether))
    }

    // MARK: - Independent Throttle Per Detector Instance

    func testDifferentCoordinatorsThrottleIndependently() {
        let coordinatorA = makeCoordinator()
        let coordinatorB = makeCoordinator()

        // Both should allow the first call.
        XCTAssertTrue(coordinatorA.shouldRecordDiagnostic(kind: .scrollWheelUntether))
        XCTAssertTrue(
            coordinatorB.shouldRecordDiagnostic(kind: .scrollWheelUntether),
            "Different coordinator instances should have independent throttle state"
        )

        // Both should throttle the immediate second call.
        XCTAssertFalse(coordinatorA.shouldRecordDiagnostic(kind: .scrollWheelUntether))
        XCTAssertFalse(coordinatorB.shouldRecordDiagnostic(kind: .scrollWheelUntether))
    }

    // MARK: - Non-Scroll Kinds Are Not Throttled

    func testNonScrollKindsAlwaysPass() {
        let coordinator = makeCoordinator()

        // Other diagnostic kinds should not be throttled.
        XCTAssertTrue(coordinator.shouldRecordDiagnostic(kind: .detectorInstall))
        XCTAssertTrue(coordinator.shouldRecordDiagnostic(kind: .detectorInstall))
        XCTAssertTrue(coordinator.shouldRecordDiagnostic(kind: .detectorUpdate))
        XCTAssertTrue(coordinator.shouldRecordDiagnostic(kind: .detectorRemove))
        XCTAssertTrue(coordinator.shouldRecordDiagnostic(kind: .scrollPositionChanged))
    }

    // MARK: - Stable Detector ID

    func testDetectorIdIsStableAcrossAccesses() {
        let coordinator = makeCoordinator()
        let id1 = coordinator.detectorId
        let id2 = coordinator.detectorId
        XCTAssertEqual(id1, id2, "detectorId should be stable across accesses")
        XCTAssertFalse(id1.isEmpty, "detectorId should not be empty")
    }

    func testEachCoordinatorGetsUniqueDetectorId() {
        let a = makeCoordinator()
        let b = makeCoordinator()
        XCTAssertNotEqual(
            a.detectorId, b.detectorId,
            "Each coordinator should have a unique detectorId"
        )
    }
}
