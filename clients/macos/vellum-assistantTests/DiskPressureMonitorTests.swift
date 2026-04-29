import XCTest
@testable import VellumAssistantLib

@MainActor
final class DiskPressureMonitorTests: XCTestCase {
    func testPressureTriggersAtEightyFivePercent() {
        let monitor = makeMonitor(assistantId: "assistant-a")

        monitor.applyHealthz(healthz(usedMb: 85, totalMb: 100), assistantId: "assistant-a")

        XCTAssertEqual(monitor.alert?.assistantId, "assistant-a")
        XCTAssertEqual(monitor.alert?.displayPercent, 85)
        XCTAssertEqual(monitor.alert?.id, "disk-pressure:assistant-a:1")
    }

    func testPressureDoesNotTriggerBelowEightyFivePercent() {
        let monitor = makeMonitor(assistantId: "assistant-a")

        monitor.applyHealthz(healthz(usedMb: 84.9, totalMb: 100), assistantId: "assistant-a")

        XCTAssertNil(monitor.alert)
    }

    func testPressureResolvesOnlyBelowEightyPercent() {
        let monitor = makeMonitor(assistantId: "assistant-a")

        monitor.applyHealthz(healthz(usedMb: 95, totalMb: 100), assistantId: "assistant-a")
        let initialAlertId = monitor.alert?.id
        monitor.applyHealthz(healthz(usedMb: 80, totalMb: 100), assistantId: "assistant-a")

        XCTAssertEqual(monitor.alert?.id, initialAlertId)
        XCTAssertEqual(monitor.alert?.displayPercent, 80)

        monitor.applyHealthz(healthz(usedMb: 79.9, totalMb: 100), assistantId: "assistant-a")

        XCTAssertNil(monitor.alert)
    }

    func testNewAlertCycleUsesStableNewId() {
        let monitor = makeMonitor(assistantId: "assistant-a")

        monitor.applyHealthz(healthz(usedMb: 95, totalMb: 100), assistantId: "assistant-a")
        XCTAssertEqual(monitor.alert?.id, "disk-pressure:assistant-a:1")

        monitor.applyHealthz(healthz(usedMb: 70, totalMb: 100), assistantId: "assistant-a")
        monitor.applyHealthz(healthz(usedMb: 91, totalMb: 100), assistantId: "assistant-a")

        XCTAssertEqual(monitor.alert?.id, "disk-pressure:assistant-a:2")
    }

    func testAssistantSwitchClearsStaleAlertAndScopesNextId() {
        let monitor = makeMonitor(assistantId: "assistant-a")

        monitor.applyHealthz(healthz(usedMb: 95, totalMb: 100), assistantId: "assistant-a")
        monitor.applyHealthz(healthz(usedMb: 95, totalMb: 100), assistantId: "assistant-b")

        XCTAssertEqual(monitor.alert?.assistantId, "assistant-b")
        XCTAssertEqual(monitor.alert?.id, "disk-pressure:assistant-b:2")
    }

    func testUnreachableOrMissingDiskMetricsClearsAlert() {
        let monitor = makeMonitor(assistantId: "assistant-a")

        monitor.applyHealthz(healthz(usedMb: 95, totalMb: 100), assistantId: "assistant-a")
        monitor.applyHealthz(nil, assistantId: "assistant-a")
        XCTAssertNil(monitor.alert)

        monitor.applyHealthz(healthz(usedMb: 95, totalMb: 100), assistantId: "assistant-a")
        monitor.applyHealthz(DaemonHealthz(status: "ok"), assistantId: "assistant-a")
        XCTAssertNil(monitor.alert)
    }

    func testInvalidDiskTotalClearsAlert() {
        let monitor = makeMonitor(assistantId: "assistant-a")

        monitor.applyHealthz(healthz(usedMb: 95, totalMb: 100), assistantId: "assistant-a")
        monitor.applyHealthz(healthz(usedMb: 95, totalMb: 0), assistantId: "assistant-a")

        XCTAssertNil(monitor.alert)
    }

    private func makeMonitor(assistantId: String) -> DiskPressureMonitor {
        DiskPressureMonitor(
            fetchHealthz: { nil },
            activeAssistantIdProvider: { assistantId },
            isConnectedProvider: { true },
            notificationCenter: NotificationCenter(),
            cadenceNanoseconds: 1_000_000_000
        )
    }

    private func healthz(usedMb: Double, totalMb: Double) -> DaemonHealthz {
        DaemonHealthz(
            status: "ok",
            disk: DaemonHealthz.DiskInfo(
                path: "/workspace",
                totalMb: totalMb,
                usedMb: usedMb,
                freeMb: max(totalMb - usedMb, 0)
            )
        )
    }
}
