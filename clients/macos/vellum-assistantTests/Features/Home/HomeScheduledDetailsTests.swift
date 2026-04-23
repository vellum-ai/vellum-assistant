import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Unit tests for ``HomeScheduledDetails``.
final class HomeScheduledDetailsTests: XCTestCase {

    // MARK: - Fixtures

    private func makeDetails(enabled: Bool = true) -> HomeScheduledDetails {
        HomeScheduledDetails(
            name: "Morning check-in",
            syntax: "cron",
            mode: "notify",
            schedule: "Every day at 9:00 AM (Europe/Ljubljana)",
            enabled: enabled,
            nextRun: Date(timeIntervalSince1970: 0),
            nextRunTimeZone: TimeZone(identifier: "Europe/Ljubljana")!,
            description: "Test description."
        )
    }

    // MARK: - displayRows

    func test_displayRows_orderAndCount() {
        let rows = makeDetails().displayRows()

        XCTAssertEqual(rows.count, 6)
        XCTAssertEqual(rows[0].key, "Name")
        XCTAssertEqual(rows[1].key, "Syntax")
        XCTAssertEqual(rows[2].key, "Mode")
        XCTAssertEqual(rows[3].key, "Schedule")
        XCTAssertEqual(rows[4].key, "Enabled")
        XCTAssertEqual(rows[5].key, "Next Run")
    }

    func test_displayRows_enabledFalseRendersAsFalse() {
        let rows = makeDetails(enabled: false).displayRows()

        let enabledRow = rows.first { $0.key == "Enabled" }
        XCTAssertEqual(enabledRow?.value, "false")
    }

    // MARK: - placeholder

    func test_placeholderHasFigmaSample() {
        let placeholder = HomeScheduledDetails.placeholder

        XCTAssertEqual(placeholder.name, "Morning check-in")
        XCTAssertEqual(placeholder.schedule, "Every day at 9:00 AM (Europe/Ljubljana)")
        XCTAssertEqual(placeholder.nextRunTimeZone, TimeZone(identifier: "Europe/Ljubljana"))
    }
}
