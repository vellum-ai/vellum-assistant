/**
 * Trust rule types shared between the assistant daemon and the gateway.
 *
 * These are extracted from `assistant/src/permissions/types.ts` and
 * `assistant/src/permissions/trust-store.ts` so that both packages can
 * reference a single canonical definition.
 */

// ---------------------------------------------------------------------------
// Trust decision
// ---------------------------------------------------------------------------

/** The possible decisions a trust rule can make. */
export type TrustDecision = "allow" | "deny" | "ask";

// ---------------------------------------------------------------------------
// Trust rule
// ---------------------------------------------------------------------------

export interface TrustRule {
  id: string;
  tool: string;
  pattern: string;
  scope: string;
  decision: TrustDecision;
  priority: number;
  createdAt: number;
  executionTarget?: string;
  allowHighRisk?: boolean;
}

// ---------------------------------------------------------------------------
// Trust file (on-disk shape)
// ---------------------------------------------------------------------------

/** Shape of the `trust.json` file persisted to disk. */
export interface TrustFileData {
  version: number;
  rules: TrustRule[];
  /** Set to true when the user explicitly accepts the starter approval bundle. */
  starterBundleAccepted?: boolean;
}
