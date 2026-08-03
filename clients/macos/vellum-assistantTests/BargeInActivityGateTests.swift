import XCTest
@testable import VellumAssistantLib

final class BargeInActivityGateTests: XCTestCase {
    func testSingleLoudBufferDoesNotFire() {
        var gate = BargeInActivityGate(rmsThreshold: 0.05, consecutiveBuffersRequired: 2)

        XCTAssertFalse(gate.observe(rms: 0.5))
    }

    func testConsecutiveLoudBuffersFireOnceThresholdReached() {
        var gate = BargeInActivityGate(rmsThreshold: 0.05, consecutiveBuffersRequired: 2)

        XCTAssertFalse(gate.observe(rms: 0.5))
        XCTAssertTrue(gate.observe(rms: 0.5))
    }

    func testQuietBufferBetweenLoudBuffersResetsTheRun() {
        // Simulates a short cough: one loud buffer, then quiet, then loud
        // again — should never accumulate to the consecutive requirement.
        var gate = BargeInActivityGate(rmsThreshold: 0.05, consecutiveBuffersRequired: 2)

        XCTAssertFalse(gate.observe(rms: 0.5))
        XCTAssertFalse(gate.observe(rms: 0.01))
        XCTAssertFalse(gate.observe(rms: 0.5))
    }

    func testBufferAtExactThresholdDoesNotCount() {
        var gate = BargeInActivityGate(rmsThreshold: 0.05, consecutiveBuffersRequired: 2)

        XCTAssertFalse(gate.observe(rms: 0.05))
        XCTAssertFalse(gate.observe(rms: 0.05))
    }

    func testFiresOnEveryBufferOnceRunIsSustained() {
        var gate = BargeInActivityGate(rmsThreshold: 0.05, consecutiveBuffersRequired: 2)

        XCTAssertFalse(gate.observe(rms: 0.5))
        XCTAssertTrue(gate.observe(rms: 0.5))
        XCTAssertTrue(gate.observe(rms: 0.5))
    }
}
