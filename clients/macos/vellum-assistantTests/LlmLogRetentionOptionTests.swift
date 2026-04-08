import XCTest
@testable import VellumAssistantLib

/// Unit tests for `LlmLogRetentionOption` — covers `closest(toMs:)` snapping
/// logic, label/case invariants, and the `.never` zero-value special case.
final class LlmLogRetentionOptionTests: XCTestCase {

    // MARK: - Exact raw-value matches

    func testClosestReturnsOneDayForExactOneDayMs() {
        XCTAssertEqual(LlmLogRetentionOption.closest(toMs: 86_400_000), .oneDay)
    }

    func testClosestReturnsSevenDaysForExactSevenDaysMs() {
        XCTAssertEqual(LlmLogRetentionOption.closest(toMs: 604_800_000), .sevenDays)
    }

    func testClosestReturnsThirtyDaysForExactThirtyDaysMs() {
        XCTAssertEqual(LlmLogRetentionOption.closest(toMs: 2_592_000_000), .thirtyDays)
    }

    func testClosestReturnsNinetyDaysForExactNinetyDaysMs() {
        XCTAssertEqual(LlmLogRetentionOption.closest(toMs: 7_776_000_000), .ninetyDays)
    }

    // MARK: - Zero / never

    func testClosestReturnsNeverForZero() {
        XCTAssertEqual(LlmLogRetentionOption.closest(toMs: 0), .never)
    }

    // MARK: - Off-grid snapping

    /// 2 days (172_800_000 ms) is closer to 1 day than to 7 days.
    func testClosestSnapsTwoDaysToOneDay() {
        XCTAssertEqual(LlmLogRetentionOption.closest(toMs: 172_800_000), .oneDay)
    }

    /// 4 days (345_600_000 ms) is closer to 7 days than to 1 day.
    func testClosestSnapsFourDaysToSevenDays() {
        XCTAssertEqual(LlmLogRetentionOption.closest(toMs: 345_600_000), .sevenDays)
    }

    // MARK: - Invariants

    func testAllCasesHasFiveEntries() {
        XCTAssertEqual(LlmLogRetentionOption.allCases.count, 5)
    }

    func testAllCasesLabelsAreNonEmpty() {
        for option in LlmLogRetentionOption.allCases {
            XCTAssertFalse(option.label.isEmpty, "Label for \(option) should not be empty")
        }
    }
}
