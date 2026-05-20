export function getRiskBadgeStyle(riskLevel?: string): { bg: string; text: string; label: string } {
  switch (riskLevel?.toLowerCase()) {
    case "low":
      return { bg: "bg-[var(--system-positive-strong)]", text: "text-white", label: "Low" };
    case "medium":
      // Amber background is light — use dark text for contrast (matches macOS RiskBadgeView).
      return { bg: "bg-[var(--system-mid-strong)]", text: "text-black", label: "Medium" };
    case "high":
      return { bg: "bg-[var(--system-negative-strong)]", text: "text-white", label: "High" };
    default:
      return { bg: "bg-[var(--content-secondary)]", text: "text-white", label: riskLevel ?? "Unknown" };
  }
}

// "unknown" maps to 2 (treated as high risk), matching server/Swift semantics.
// Unrecognized values fall through to the ?? -1 default (treated as no-risk / missing).
const RISK_ORDINAL: Record<string, number> = { unknown: 2, low: 0, medium: 1, high: 2 };
const THRESHOLD_ORDINAL: Record<string, number> = { none: -1, low: 0, medium: 1, high: 2 };

/**
 * Returns false when an auto-approved tool call exceeded the configured threshold —
 * i.e., the outcome looks surprising and warrants an inline explanation.
 * Returns true for all other approval modes (prompted/blocked are always expected).
 * Returns true when any field is missing (backward compat: no provenance for legacy records).
 */
export function wasExpected(
  approvalMode: string | undefined,
  riskLevel: string | undefined,
  riskThreshold: string | undefined,
): boolean {
  if (approvalMode?.toLowerCase() !== "auto") return true;
  if (!riskThreshold) return true;
  return (RISK_ORDINAL[(riskLevel ?? "").toLowerCase()] ?? -1) <= (THRESHOLD_ORDINAL[riskThreshold.toLowerCase()] ?? -1);
}

/**
 * Maps an approvalReason enum value to the inline provenance suffix shown on the risk badge.
 * Returns null for reasons that don't warrant provenance display (expected outcomes).
 */
export function getProvenanceText(approvalReason: string | undefined): string | null {
  switch (approvalReason) {
    case "trust_rule_allowed":    return "· Auto-approved · Trust rule matched";
    case "sandbox_auto_approve":  return "· Auto-approved · Sandboxed workspace";
    case "platform_auto_approve": return "· Auto-approved · Platform session";
    default:                      return null;
  }
}
