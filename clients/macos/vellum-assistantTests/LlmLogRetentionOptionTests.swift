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

    /// 2 days (172_800_000 ms) is closer to 1 day (1 day away) than to 7 days (5 days away).
    /// Not a tie — `.oneDay` is genuinely closer.
    func testClosestSnapsTwoDaysToOneDay() {
        XCTAssertEqual(LlmLogRetentionOption.closest(toMs: 172_800_000), .oneDay)
    }

    // MARK: - Tie-breaking (snap up to larger retention)

    /// 4 days (345_600_000 ms) is exactly halfway between 1 day and 7 days.
    /// Tie-breaking rule: snap up to the larger retention → `.sevenDays`.
    func testClosestSnapsExactMidpointBetweenOneAndSevenDaysToSevenDays() {
        XCTAssertEqual(LlmLogRetentionOption.closest(toMs: 345_600_000), .sevenDays)
    }

    /// Exact midpoint between 7 days (604_800_000) and 30 days (2_592_000_000):
    /// (604_800_000 + 2_592_000_000) / 2 = 1_598_400_000 ms (≈18.5 days).
    /// Tie-breaking rule: snap up to the larger retention → `.thirtyDays`.
    func testClosestSnapsExactMidpointBetweenSevenAndThirtyDaysToThirtyDays() {
        XCTAssertEqual(LlmLogRetentionOption.closest(toMs: 1_598_400_000), .thirtyDays)
    }

    /// Exact midpoint between 30 days (2_592_000_000) and 90 days (7_776_000_000):
    /// (2_592_000_000 + 7_776_000_000) / 2 = 5_184_000_000 ms (60 days).
    /// Tie-breaking rule: snap up to the larger retention → `.ninetyDays`.
    func testClosestSnapsExactMidpointBetweenThirtyAndNinetyDaysToNinetyDays() {
        XCTAssertEqual(LlmLogRetentionOption.closest(toMs: 5_184_000_000), .ninetyDays)
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
