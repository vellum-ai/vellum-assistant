import type { TrustRuleRisk } from "@/types/trust-rules";

const VALID_RISK_LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high"]);

/** Narrows an untrusted wire string to a valid TrustRuleRisk, defaulting to "medium". */
export function toRiskLevel(value: string | undefined): TrustRuleRisk {
  const normalized = value?.toLowerCase();
  if (normalized && VALID_RISK_LEVELS.has(normalized)) return normalized as TrustRuleRisk;
  return "medium";
}

export function getRiskBadgeStyle(riskLevel?: string): { bg: string; text: string; label: string; border?: string } {
  switch (riskLevel?.toLowerCase()) {
    case "low":
      return { bg: "bg-[var(--system-positive-strong)]", text: "text-white", label: "Low" };
    case "medium":
      // Amber background is light — use dark text for contrast (matches macOS RiskBadgeView).
      return { bg: "bg-[var(--system-mid-strong)]", text: "text-black", label: "Medium" };
    case "high":
      return { bg: "bg-[var(--system-negative-strong)]", text: "text-white", label: "High" };
    case "workspace":
      return {
        bg: "bg-[var(--surface-lift)]",
        text: "text-[var(--content-secondary)]",
        border: "border border-[var(--border-element)]",
        label: "Workspace",
      };
    default:
      return { bg: "bg-[var(--content-secondary)]", text: "text-white", label: riskLevel ?? "Unknown" };
  }
}

/**
 * Human description of when a call at this risk level gets auto-approved.
 * Shown under the risk badge in the tool-detail drawer's Reasoning card and
 * as the trust-rule modal's "Treat as" hint. Undefined for levels that don't
 * map to a tolerance tier (e.g. "workspace", "unknown").
 */
export function getRiskToleranceHint(riskLevel?: string): string | undefined {
  switch (riskLevel?.toLowerCase()) {
    case "low":
      return "Auto-approved at Conservative tolerance or higher";
    case "medium":
      return "Auto-approved at Relaxed tolerance or higher";
    case "high":
      return "Auto-approved only at Full Access tolerance";
    default:
      return undefined;
  }
}

/**
 * Weak-background / strong-text variant of the risk badge styling, matching the
 * macOS `RiskBadgeView` convention (Figma node 5010-103197). This is the style
 * used by the inline pill + drawer header — distinct from the filled
 * `getRiskBadgeStyle` that the confirmation chip depends on.
 */
export function getRiskBadgeWeakStyle(riskLevel?: string): { bg: string; text: string; label: string } {
  switch (riskLevel?.toLowerCase()) {
    case "low":
      return { bg: "bg-[var(--system-positive-weak)]", text: "text-[var(--system-positive-strong)]", label: "Low" };
    case "medium":
      return { bg: "bg-[var(--system-mid-weak)]", text: "text-[var(--system-mid-strong)]", label: "Medium" };
    case "high":
      return { bg: "bg-[var(--system-negative-weak)]", text: "text-[var(--system-negative-strong)]", label: "High" };
    case "workspace":
      return { bg: "bg-[var(--surface-lift)]", text: "text-[var(--content-secondary)]", label: "Workspace" };
    default:
      return {
        bg: "bg-[var(--surface-lift)]",
        text: "text-[var(--content-secondary)]",
        label: riskLevel ? riskLevel.charAt(0).toUpperCase() + riskLevel.slice(1) : "Unknown",
      };
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
    case "sandbox_auto_approve":  return null;
    case "platform_auto_approve": return "· Auto-approved · Platform session";
    default:                      return null;
  }
}

/**
 * Maps an approvalReason to the effective chip display level.
 * Sandbox-auto-approved tools render a neutral "Workspace" chip instead of
 * the inherent risk color, while preserving the original risk for tooltips.
 */
export function getEffectiveRiskDisplay(
  approvalReason?: string,
  riskLevel?: string,
): { displayLevel: string; inherentRisk?: string } {
  if (approvalReason === "sandbox_auto_approve") {
    return { displayLevel: "workspace", inherentRisk: riskLevel };
  }
  return { displayLevel: riskLevel ?? "unknown" };
}
