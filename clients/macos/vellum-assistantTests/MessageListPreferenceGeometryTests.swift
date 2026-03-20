import XCTest
@testable import VellumAssistantLib

final class MessageListPreferenceGeometryTests: XCTestCase {

    // MARK: - Finite-to-finite acceptance

    /// A normal finite update that exceeds the dead-zone should be accepted.
    func testFiniteToFiniteAccepted() {
        let result = PreferenceGeometryFilter.evaluate(
            newValue: 100,
            previous: 50
        )
        XCTAssertEqual(result, .accept(100))
    }

    /// A finite value arriving when no previous measurement exists (.infinity)
    /// should always be accepted regardless of dead-zone.
    func testFirstFiniteMeasurementAccepted() {
        let result = PreferenceGeometryFilter.evaluate(
            newValue: 300,
            previous: .infinity
        )
        XCTAssertEqual(result, .accept(300))
    }

    /// Negative finite values are valid geometry positions and should be
    /// accepted when they exceed the dead-zone.
    func testNegativeFiniteValueAccepted() {
        let result = PreferenceGeometryFilter.evaluate(
            newValue: -20,
            previous: 100
        )
        XCTAssertEqual(result, .accept(-20))
    }

    /// Zero is a valid finite measurement.
    func testZeroIsAccepted() {
        let result = PreferenceGeometryFilter.evaluate(
            newValue: 0,
            previous: 500
        )
        XCTAssertEqual(result, .accept(0))
    }

    // MARK: - Non-finite rejection

    /// NaN must be rejected to preserve the last known finite measurement.
    func testNaNRejected() {
        let result = PreferenceGeometryFilter.evaluate(
            newValue: .nan,
            previous: 100
        )
        XCTAssertEqual(result, .rejectNonFinite)
    }

    /// Positive infinity must be rejected.
    func testPositiveInfinityRejected() {
        let result = PreferenceGeometryFilter.evaluate(
            newValue: .infinity,
            previous: 100
        )
        XCTAssertEqual(result, .rejectNonFinite)
    }

    /// Negative infinity must be rejected.
    func testNegativeInfinityRejected() {
        let result = PreferenceGeometryFilter.evaluate(
            newValue: -.infinity,
            previous: 100
        )
        XCTAssertEqual(result, .rejectNonFinite)
    }

    /// Non-finite values must also be rejected when there is no prior
    /// measurement (previous = .infinity).
    func testNonFiniteRejectedWhenNoPriorMeasurement() {
        XCTAssertEqual(
            PreferenceGeometryFilter.evaluate(newValue: .nan, previous: .infinity),
            .rejectNonFinite
        )
        XCTAssertEqual(
            PreferenceGeometryFilter.evaluate(newValue: .infinity, previous: .infinity),
            .rejectNonFinite
        )
        XCTAssertEqual(
            PreferenceGeometryFilter.evaluate(newValue: -.infinity, previous: .infinity),
            .rejectNonFinite
        )
    }

    // MARK: - Recovery from unknown geometry

    /// After a non-finite rejection, the next finite value must be accepted
    /// (the previous value stays at whatever the caller last stored, which
    /// could be .infinity if no finite value was ever recorded).
    func testRecoveryFromNeverMeasured() {
        // First update is non-finite — rejected.
        let first = PreferenceGeometryFilter.evaluate(
            newValue: .nan,
            previous: .infinity
        )
        XCTAssertEqual(first, .rejectNonFinite)

        // Second update is finite — accepted (previous is still .infinity
        // because the caller never stored anything).
        let second = PreferenceGeometryFilter.evaluate(
            newValue: 200,
            previous: .infinity
        )
        XCTAssertEqual(second, .accept(200))
    }

    /// Simulates the sequence: finite -> non-finite -> finite. The non-finite
    /// value is rejected (preserving the previous finite value), then the
    /// next finite value is evaluated against the preserved previous.
    func testRecoveryAfterTransientNonFinite() {
        // 1. Initial finite measurement accepted.
        let first = PreferenceGeometryFilter.evaluate(
            newValue: 100,
            previous: .infinity
        )
        XCTAssertEqual(first, .accept(100))

        // 2. Non-finite arrives — rejected; caller keeps previous = 100.
        let second = PreferenceGeometryFilter.evaluate(
            newValue: .nan,
            previous: 100
        )
        XCTAssertEqual(second, .rejectNonFinite)

        // 3. Finite recovery — evaluated against preserved previous (100).
        let third = PreferenceGeometryFilter.evaluate(
            newValue: 150,
            previous: 100
        )
        XCTAssertEqual(third, .accept(150))
    }

    // MARK: - Dead-zone suppression

    /// An update within the default 2pt dead-zone should be suppressed.
    func testWithinDeadZoneSuppressed() {
        let result = PreferenceGeometryFilter.evaluate(
            newValue: 101,
            previous: 100
        )
        XCTAssertEqual(result, .rejectDeadZone)
    }

    /// An update exactly at the dead-zone boundary (delta == 2) should be
    /// suppressed (the threshold is exclusive: abs(delta) must be > deadZone).
    func testExactDeadZoneBoundarySuppressed() {
        let result = PreferenceGeometryFilter.evaluate(
            newValue: 102,
            previous: 100
        )
        XCTAssertEqual(result, .rejectDeadZone)
    }

    /// An update just past the dead-zone boundary should be accepted.
    func testJustPastDeadZoneAccepted() {
        let result = PreferenceGeometryFilter.evaluate(
            newValue: 102.01,
            previous: 100
        )
        XCTAssertEqual(result, .accept(102.01))
    }

    /// Dead-zone applies symmetrically for negative deltas.
    func testNegativeDeltaDeadZoneSuppressed() {
        let result = PreferenceGeometryFilter.evaluate(
            newValue: 99,
            previous: 100
        )
        XCTAssertEqual(result, .rejectDeadZone)
    }

    /// Dead-zone is not applied when previous is non-finite (.infinity),
    /// because there is no valid baseline to compare against.
    func testDeadZoneSkippedWhenNoPriorMeasurement() {
        // Delta from .infinity to 0 would be infinite, but the dead-zone
        // check is only entered when previous.isFinite, so this is accepted.
        let result = PreferenceGeometryFilter.evaluate(
            newValue: 0,
            previous: .infinity
        )
        XCTAssertEqual(result, .accept(0))
    }

    // MARK: - Zero dead-zone (disabled suppression)

    /// When dead-zone is 0, every finite change is accepted regardless of
    /// magnitude. This is used for preference keys like ScrollViewportHeightKey
    /// where every change matters.
    func testZeroDeadZoneAcceptsSmallChange() {
        let result = PreferenceGeometryFilter.evaluate(
            newValue: 100.5,
            previous: 100,
            deadZone: 0
        )
        XCTAssertEqual(result, .accept(100.5))
    }

    /// Even with zero dead-zone, non-finite values are still rejected.
    func testZeroDeadZoneStillRejectsNonFinite() {
        let result = PreferenceGeometryFilter.evaluate(
            newValue: .nan,
            previous: 100,
            deadZone: 0
        )
        XCTAssertEqual(result, .rejectNonFinite)
    }

    // MARK: - Custom dead-zone

    /// A larger custom dead-zone should suppress larger deltas.
    func testCustomLargerDeadZone() {
        let result = PreferenceGeometryFilter.evaluate(
            newValue: 108,
            previous: 100,
            deadZone: 10
        )
        XCTAssertEqual(result, .rejectDeadZone)

        let result2 = PreferenceGeometryFilter.evaluate(
            newValue: 111,
            previous: 100,
            deadZone: 10
        )
        XCTAssertEqual(result2, .accept(111))
    }

    // MARK: - Decision type equality

    /// Verify that two `.accept` decisions with the same value are equal,
    /// and different values are not.
    func testDecisionEquality() {
        XCTAssertEqual(PreferenceFilterDecision.accept(10), PreferenceFilterDecision.accept(10))
        XCTAssertNotEqual(PreferenceFilterDecision.accept(10), PreferenceFilterDecision.accept(20))
        XCTAssertNotEqual(PreferenceFilterDecision.accept(10), PreferenceFilterDecision.rejectNonFinite)
        XCTAssertNotEqual(PreferenceFilterDecision.rejectNonFinite, PreferenceFilterDecision.rejectDeadZone)
        XCTAssertEqual(PreferenceFilterDecision.rejectNonFinite, PreferenceFilterDecision.rejectNonFinite)
        XCTAssertEqual(PreferenceFilterDecision.rejectDeadZone, PreferenceFilterDecision.rejectDeadZone)
    }
}
