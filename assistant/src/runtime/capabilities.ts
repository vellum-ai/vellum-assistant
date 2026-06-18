/**
 * Trust capabilities — what an actor may do once admitted.
 *
 * Separates *what an actor can do* (capabilities/permissions) from *who the
 * actor is* (`TrustClass`, their role/level). Today the ~40+ decision sites
 * re-derive permissions inline from the raw class (`trustClass === "guardian"`).
 * This resolves the class to a named capability set in one place so call sites
 * read a capability instead of re-deriving it.
 *
 * Stateless / derive-on-read: capabilities are derived from the already-resolved
 * (and already-persisted) `trustClass` at point of use. Nothing here is stored;
 * `trustClass` remains the persisted field in retry payloads, the journal store,
 * and conversation CRUD.
 *
 * Admission is a SEPARATE axis: `TRUST_CLASS_RANK` vs `ADMISSION_FLOOR`
 * ("who gets in the door") is intentionally not modeled here. `CapabilitySet`
 * is the "what they may do once inside" axis.
 *
 * Context-dependent decisions (interactivity routing, self-approval races,
 * channel-specific overrides) COMPOSE these primitives with runtime context at
 * the call site — they are not encoded in the table.
 */

import type { TrustClass } from "./actor-trust-resolver.js";

/**
 * Outcome when an actor invokes a tool that requires guardian approval.
 * - `self`: the actor self-approves (guardian).
 * - `escalate-and-wait`: route to the guardian and wait inline for a grant.
 * - `deny`: fail-closed, no escalation or wait.
 */
export type SensitiveToolApproval = "self" | "escalate-and-wait" | "deny";

/**
 * Which trust-guidance block to inject into the model prompt. The capability
 * layer owns the *selector*; the prompt layer owns the copy for each value.
 */
export type PromptTrustGuidance =
  | "none"
  | "social-engineering-defense"
  | "stranger-warning";

/**
 * What an actor may do once admitted, derived purely from their trust class.
 */
export interface CapabilitySet {
  // --- Tool execution & approval ---
  /** Self-approves own tool invocations. Non-guardians route to the guardian. */
  canSelfApproveTools: boolean;
  /** Outcome when a guardian-approval-required (sensitive) tool is invoked. */
  sensitiveToolApproval: SensitiveToolApproval;
  /** May create/update schedules. */
  canManageSchedules: boolean;
  /** May use verification control-plane tools. */
  canUseVerificationControlPlane: boolean;
  /** May archive messages by sender. */
  canArchiveBySender: boolean;

  // --- Data & memory ---
  /**
   * May read/analyze long-term memory: the recall tool, auto-analysis,
   * memory retrospection, and inclusion during context compaction.
   */
  canAccessMemory: boolean;
  /**
   * May perform privileged (non-conversation-scoped) document operations.
   * Composed at the call site with the `vellum`-channel override.
   */
  canAccessPrivilegedDocuments: boolean;

  // --- Execution environment ---
  /**
   * Shell runs WITHOUT the untrusted sandbox / CES lockdown (no
   * `VELLUM_UNTRUSTED_SHELL`, no credential-secrecy confinement).
   */
  unsandboxedShell: boolean;

  // --- Interactivity & resource ---
  /**
   * Trust class alone permits interactive guardian-approval waits. Composed
   * downstream with `guardianRouteResolvable` to derive `promptWaitingAllowed`
   * (see `resolveRoutingState`).
   */
  mayBeInteractive: boolean;
  /** May trigger cleanup-mode operations under disk pressure. */
  canActUnderDiskPressureCleanup: boolean;

  // --- Prompt shaping ---
  /** Which trust-guidance block to inject into the model prompt. */
  promptTrustGuidance: PromptTrustGuidance;
}

/**
 * Guardian: full control-plane access, self-approves tools.
 */
const GUARDIAN_CAPABILITIES: CapabilitySet = {
  canSelfApproveTools: true,
  sensitiveToolApproval: "self",
  canManageSchedules: true,
  canUseVerificationControlPlane: true,
  canArchiveBySender: true,
  canAccessMemory: true,
  canAccessPrivilegedDocuments: true,
  unsandboxedShell: true,
  mayBeInteractive: true,
  canActUnderDiskPressureCleanup: true,
  promptTrustGuidance: "none",
};

/**
 * Trusted / unverified contacts: may invoke tools but escalate sensitive ones
 * to the guardian; no privileged data access; sandboxed execution.
 *
 * `trusted_contact` and `unverified_contact` are deliberately identical here —
 * the distinction is admission-only (see `actor-trust-resolver.ts`). The matrix
 * test pins this invariant.
 */
const CONTACT_CAPABILITIES: CapabilitySet = {
  canSelfApproveTools: false,
  sensitiveToolApproval: "escalate-and-wait",
  canManageSchedules: false,
  canUseVerificationControlPlane: false,
  canArchiveBySender: false,
  canAccessMemory: false,
  canAccessPrivilegedDocuments: false,
  unsandboxedShell: false,
  mayBeInteractive: true,
  canActUnderDiskPressureCleanup: false,
  promptTrustGuidance: "social-engineering-defense",
};

/**
 * Unknown actors: fail-closed. No escalation, no interactivity, treated as a
 * potential stranger in the prompt.
 */
const UNKNOWN_CAPABILITIES: CapabilitySet = {
  canSelfApproveTools: false,
  sensitiveToolApproval: "deny",
  canManageSchedules: false,
  canUseVerificationControlPlane: false,
  canArchiveBySender: false,
  canAccessMemory: false,
  canAccessPrivilegedDocuments: false,
  unsandboxedShell: false,
  mayBeInteractive: false,
  canActUnderDiskPressureCleanup: false,
  promptTrustGuidance: "stranger-warning",
};

const CAPABILITIES_BY_CLASS: Record<TrustClass, CapabilitySet> = {
  guardian: GUARDIAN_CAPABILITIES,
  trusted_contact: CONTACT_CAPABILITIES,
  unverified_contact: CONTACT_CAPABILITIES,
  unknown: UNKNOWN_CAPABILITIES,
};

/**
 * Resolve the capability set for a trust class. Pure and stateless.
 *
 * This is the single fail-closed trust boundary: any value that is not a
 * recognized `TrustClass` — including `undefined` and legacy/persisted strings
 * (e.g. `"non_guardian"`) — resolves to the `unknown` capability set. Callers
 * pass their raw trust value directly; they never re-derive "is this a known
 * class?" at the call site. The `(string & {})` member keeps autocomplete for
 * the known classes while still accepting an arbitrary string.
 */
export function resolveCapabilities(
  trustClass: TrustClass | (string & {}) | undefined,
): CapabilitySet {
  return CAPABILITIES_BY_CLASS[trustClass as TrustClass] ?? UNKNOWN_CAPABILITIES;
}
