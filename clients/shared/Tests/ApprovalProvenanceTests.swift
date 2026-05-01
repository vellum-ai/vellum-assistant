import XCTest
@testable import VellumAssistantShared

final class ApprovalProvenanceTests: XCTestCase {

    // MARK: - wasExpected

    func test_prompted_alwaysExpected() {
        XCTAssertTrue(wasExpected(approvalMode: "prompted", riskLevel: "high", riskThreshold: "none"))
    }

    func test_blocked_alwaysExpected() {
        XCTAssertTrue(wasExpected(approvalMode: "blocked", riskLevel: "high", riskThreshold: "none"))
    }

    func test_unknown_alwaysExpected() {
        XCTAssertTrue(wasExpected(approvalMode: "unknown", riskLevel: "high", riskThreshold: "none"))
    }

    func test_auto_withinThreshold() {
        XCTAssertTrue(wasExpected(approvalMode: "auto", riskLevel: "low",    riskThreshold: "low"))
        XCTAssertTrue(wasExpected(approvalMode: "auto", riskLevel: "low",    riskThreshold: "medium"))
        XCTAssertTrue(wasExpected(approvalMode: "auto", riskLevel: "medium", riskThreshold: "medium"))
        XCTAssertTrue(wasExpected(approvalMode: "auto", riskLevel: "high",   riskThreshold: "high"))
    }

    func test_auto_aboveThreshold_unexpected() {
        XCTAssertFalse(wasExpected(approvalMode: "auto", riskLevel: "high",   riskThreshold: "low"))
        XCTAssertFalse(wasExpected(approvalMode: "auto", riskLevel: "high",   riskThreshold: "medium"))
        XCTAssertFalse(wasExpected(approvalMode: "auto", riskLevel: "medium", riskThreshold: "low"))
        XCTAssertFalse(wasExpected(approvalMode: "auto", riskLevel: "high",   riskThreshold: "none"))
        XCTAssertFalse(wasExpected(approvalMode: "auto", riskLevel: "medium", riskThreshold: "none"))
        XCTAssertFalse(wasExpected(approvalMode: "auto", riskLevel: "low",    riskThreshold: "none"))
    }

    func test_nilFields_treatedAsExpected() {
        // nil approvalMode → non-"auto" → always expected
        XCTAssertTrue(wasExpected(approvalMode: nil, riskLevel: "high", riskThreshold: "none"))
        // nil riskLevel → ordinal -1 ≤ -1 (none threshold) → true
        XCTAssertTrue(wasExpected(approvalMode: "auto", riskLevel: nil, riskThreshold: "none"))
    }

    // MARK: - approvalProvenanceText

    func test_knownReasons() {
        XCTAssertEqual(approvalProvenanceText(approvalReason: "trust_rule_allowed"),    "· Auto-approved · Trust rule matched")
        XCTAssertEqual(approvalProvenanceText(approvalReason: "sandbox_auto_approve"),  "· Auto-approved · Sandboxed workspace")
        XCTAssertEqual(approvalProvenanceText(approvalReason: "platform_auto_approve"), "· Auto-approved · Platform session")
        XCTAssertEqual(approvalProvenanceText(approvalReason: "no_interactive_client"), "· Blocked · No interactive session")
    }

    func test_expectedReasons_returnNil() {
        XCTAssertNil(approvalProvenanceText(approvalReason: "within_threshold"))
        XCTAssertNil(approvalProvenanceText(approvalReason: "user_approved"))
        XCTAssertNil(approvalProvenanceText(approvalReason: "user_denied"))
        XCTAssertNil(approvalProvenanceText(approvalReason: "timed_out"))
        XCTAssertNil(approvalProvenanceText(approvalReason: nil))
    }
}
