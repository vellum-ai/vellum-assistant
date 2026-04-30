import XCTest
@testable import VellumAssistantLib

@MainActor
final class DiskPressureMonitorTests: XCTestCase {
    func testPressureTriggersAtEightyFivePercent() {
        let monitor = makeMonitor(assistantId: "assistant-a")

        monitor.applyUsageFraction(0.85, assistantId: "assistant-a")

        XCTAssertEqual(monitor.alert?.assistantId, "assistant-a")
        XCTAssertEqual(monitor.alert?.displayPercent, 85)
        XCTAssertEqual(monitor.alert?.id, "disk-pressure:assistant-a:1")
    }

    func testPressureDoesNotTriggerBelowEightyFivePercent() {
        let monitor = makeMonitor(assistantId: "assistant-a")

        monitor.applyUsageFraction(0.849, assistantId: "assistant-a")

        XCTAssertNil(monitor.alert)
    }

    func testPressureResolvesOnlyBelowEightyPercent() {
        let monitor = makeMonitor(assistantId: "assistant-a")

        monitor.applyUsageFraction(0.95, assistantId: "assistant-a")
        let initialAlertId = monitor.alert?.id
        monitor.applyUsageFraction(0.80, assistantId: "assistant-a")

        XCTAssertEqual(monitor.alert?.id, initialAlertId)
        XCTAssertEqual(monitor.alert?.displayPercent, 80)

        monitor.applyUsageFraction(0.799, assistantId: "assistant-a")

        XCTAssertNil(monitor.alert)
    }

    func testNewAlertCycleUsesStableNewId() {
        let monitor = makeMonitor(assistantId: "assistant-a")

        monitor.applyUsageFraction(0.95, assistantId: "assistant-a")
        XCTAssertEqual(monitor.alert?.id, "disk-pressure:assistant-a:1")

        monitor.applyUsageFraction(0.70, assistantId: "assistant-a")
        monitor.applyUsageFraction(0.91, assistantId: "assistant-a")

        XCTAssertEqual(monitor.alert?.id, "disk-pressure:assistant-a:2")
    }

    func testAssistantSwitchClearsStaleAlertAndScopesNextId() {
        let monitor = makeMonitor(assistantId: "assistant-a")

        monitor.applyUsageFraction(0.95, assistantId: "assistant-a")
        monitor.applyUsageFraction(0.95, assistantId: "assistant-b")

        XCTAssertEqual(monitor.alert?.assistantId, "assistant-b")
        XCTAssertEqual(monitor.alert?.id, "disk-pressure:assistant-b:2")
    }

    func testNilUsageFractionClearsAlert() {
        let monitor = makeMonitor(assistantId: "assistant-a")

        monitor.applyUsageFraction(0.95, assistantId: "assistant-a")
        monitor.applyUsageFraction(nil, assistantId: "assistant-a")

        XCTAssertNil(monitor.alert)
    }

    func testNilAssistantIdClearsAlert() {
        let monitor = makeMonitor(assistantId: "assistant-a")

        monitor.applyUsageFraction(0.95, assistantId: "assistant-a")
        monitor.applyUsageFraction(0.95, assistantId: nil)

        XCTAssertNil(monitor.alert)
    }

    func testNonFiniteUsageFractionClearsAlert() {
        let monitor = makeMonitor(assistantId: "assistant-a")

        monitor.applyUsageFraction(0.95, assistantId: "assistant-a")
        monitor.applyUsageFraction(.nan, assistantId: "assistant-a")

        XCTAssertNil(monitor.alert)
    }

    private func makeMonitor(assistantId: String) -> DiskPressureMonitor {
        DiskPressureMonitor(
            fetchUsageFraction: { nil },
            activeAssistantIdProvider: { assistantId },
            notificationCenter: NotificationCenter(),
            cadenceNanoseconds: 1_000_000_000
        )
    }
}
