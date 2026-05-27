import Foundation

/// Pure derivations for approval provenance display. No UI dependencies.

/// Returns false when an auto-approved tool call exceeded the configured threshold —
/// i.e., the outcome looks surprising and warrants an inline explanation.
public func wasExpected(approvalMode: String?, riskLevel: String?, riskThreshold: String?) -> Bool {
    guard approvalMode == "auto" else { return true }  // prompted/blocked always expected
    // "unknown" maps to 2 (high) — matches server-side RISK_ORDINAL fallback semantics
    let riskOrdinal: [String: Int] = ["unknown": 2, "low": 0, "medium": 1, "high": 2]
    let thresholdOrdinal: [String: Int] = ["none": -1, "low": 0, "medium": 1, "high": 2]
    let risk = riskOrdinal[riskLevel ?? ""] ?? -1
    let threshold = thresholdOrdinal[riskThreshold ?? ""] ?? -1
    return risk <= threshold
}

/// Returns the inline provenance suffix to append to the risk badge label, or nil
/// when no provenance should be shown (expected outcome or missing fields).
///
/// For `sandbox_auto_approve`, returns nil — the Workspace chip now communicates
/// this provenance visually, so inline text is redundant.
public func approvalProvenanceText(approvalReason: String?) -> String? {
    switch approvalReason {
    case "trust_rule_allowed":    return "· Auto-approved · Trust rule matched"
    case "sandbox_auto_approve":  return nil
    case "platform_auto_approve": return "· Auto-approved · Platform session"
    // "no_interactive_client" has approvalMode "blocked", so wasExpected always
    // returns true for it — the call site never reaches here for that reason.
    default:                      return nil
    }
}

/// Determines the display risk level and inherent risk for rendering.
///
/// For sandbox-auto-approved tool calls, returns `"workspace"` as the display level
/// so `RiskBadgeView` renders the muted Workspace chip, and preserves the original
/// risk level as `inherentRisk` for tooltip display. For all other cases, passes
/// through the original risk level unchanged.
public func effectiveRiskDisplay(approvalReason: String?, riskLevel: String?) -> (displayLevel: String, inherentRisk: String?) {
    if approvalReason == "sandbox_auto_approve" {
        return (displayLevel: "workspace", inherentRisk: riskLevel)
    }
    return (displayLevel: riskLevel ?? "unknown", inherentRisk: nil)
}
