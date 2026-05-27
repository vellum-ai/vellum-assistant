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

    func test_auto_unknownRisk_treatedAsHigh() {
        // "unknown" risk maps to ordinal 2 (high) — matches server-side RISK_ORDINAL fallback.
        // An auto-approved unknown-risk call should surface provenance when threshold < high.
        XCTAssertFalse(wasExpected(approvalMode: "auto", riskLevel: "unknown", riskThreshold: "low"))
        XCTAssertFalse(wasExpected(approvalMode: "auto", riskLevel: "unknown", riskThreshold: "medium"))
        XCTAssertFalse(wasExpected(approvalMode: "auto", riskLevel: "unknown", riskThreshold: "none"))
        XCTAssertTrue(wasExpected(approvalMode: "auto",  riskLevel: "unknown", riskThreshold: "high"))
    }

    func test_nilFields_treatedAsExpected() {
        // nil approvalMode → non-"auto" → always expected
        XCTAssertTrue(wasExpected(approvalMode: nil, riskLevel: "high", riskThreshold: "none"))
        // nil riskLevel → "" not in riskOrdinal → fallback -1 ≤ -1 (none threshold) → true
        XCTAssertTrue(wasExpected(approvalMode: "auto", riskLevel: nil, riskThreshold: "none"))
    }

    // MARK: - approvalProvenanceText

    func test_knownReasons() {
        XCTAssertEqual(approvalProvenanceText(approvalReason: "trust_rule_allowed"),    "· Auto-approved · Trust rule matched")
        XCTAssertEqual(approvalProvenanceText(approvalReason: "platform_auto_approve"), "· Auto-approved · Platform session")
    }

    func test_sandboxAutoApprove_returnsNil() {
        // sandbox_auto_approve no longer shows inline text — the Workspace chip communicates provenance visually.
        XCTAssertNil(approvalProvenanceText(approvalReason: "sandbox_auto_approve"))
    }

    func test_expectedReasons_returnNil() {
        XCTAssertNil(approvalProvenanceText(approvalReason: "within_threshold"))
        XCTAssertNil(approvalProvenanceText(approvalReason: "user_approved"))
        XCTAssertNil(approvalProvenanceText(approvalReason: "user_denied"))
        XCTAssertNil(approvalProvenanceText(approvalReason: "timed_out"))
        // "no_interactive_client" has approvalMode "blocked" — wasExpected always returns
        // true for it, so this path is never reached from the call site.
        XCTAssertNil(approvalProvenanceText(approvalReason: "no_interactive_client"))
        XCTAssertNil(approvalProvenanceText(approvalReason: nil))
    }

    // MARK: - effectiveRiskDisplay (tuple overload)

    func test_effectiveRiskDisplay_sandboxAutoApprove_highRisk() {
        let result: (displayLevel: String, inherentRisk: String?) = effectiveRiskDisplay(
            approvalReason: "sandbox_auto_approve", riskLevel: "high"
        )
        XCTAssertEqual(result.displayLevel, "workspace")
        XCTAssertEqual(result.inherentRisk, "high")
    }

    func test_effectiveRiskDisplay_sandboxAutoApprove_mediumRisk() {
        let result: (displayLevel: String, inherentRisk: String?) = effectiveRiskDisplay(
            approvalReason: "sandbox_auto_approve", riskLevel: "medium"
        )
        XCTAssertEqual(result.displayLevel, "workspace")
        XCTAssertEqual(result.inherentRisk, "medium")
    }

    func test_effectiveRiskDisplay_nilApprovalReason_mediumRisk() {
        let result: (displayLevel: String, inherentRisk: String?) = effectiveRiskDisplay(
            approvalReason: nil, riskLevel: "medium"
        )
        XCTAssertEqual(result.displayLevel, "medium")
        XCTAssertNil(result.inherentRisk)
    }

    func test_effectiveRiskDisplay_trustRuleAllowed_lowRisk() {
        let result: (displayLevel: String, inherentRisk: String?) = effectiveRiskDisplay(
            approvalReason: "trust_rule_allowed", riskLevel: "low"
        )
        XCTAssertEqual(result.displayLevel, "low")
        XCTAssertNil(result.inherentRisk)
    }

    func test_effectiveRiskDisplay_nilRiskLevel_defaultsToUnknown() {
        let result: (displayLevel: String, inherentRisk: String?) = effectiveRiskDisplay(
            approvalReason: nil, riskLevel: nil
        )
        XCTAssertEqual(result.displayLevel, "unknown")
        XCTAssertNil(result.inherentRisk)
    }
}
