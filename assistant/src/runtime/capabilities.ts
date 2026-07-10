/**
 * Trust capabilities — what an actor may do once admitted.
 *
 * Separates *what an actor can do* (capabilities/permissions) from *who the
 * actor is* (`TrustClass`, their role/level). The ~40+ decision sites
 * read a named capability instead of re-deriving permissions inline from the
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
 * channel-specific overrides) COMPOSE these primitives with runtime context.
 * They are not encoded in the table; named composition helpers live in
 * `effective-capabilities.ts` (and `resolveRoutingState` in
 * `trust-context-resolver.ts`).
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
  // --- Tool approval mechanism ---
  /**
   * Auto-approves *ordinary* tool calls (e.g. background/platform-hosted bash)
   * and honors the actor's own pending-confirmation callback. The
   * sensitive/guardian-required tool path is governed separately by
   * `sensitiveToolApproval`; the two are independent levers.
   */
  canSelfApproveTools: boolean;
  /** Outcome when a guardian-approval-required (sensitive) tool is invoked. */
  sensitiveToolApproval: SensitiveToolApproval;

  // --- Privileged tool gates ---
  /** May create/update schedules. */
  canManageSchedules: boolean;
  /** May use verification control-plane tools. */
  canUseVerificationControlPlane: boolean;
  /**
   * May treat its own `user_approved` flag as sufficient authorization to
   * archive-by-sender. Non-guardians can still archive by sender, but must be
   * authorized via surface action, task, or explicit prompt approval instead.
   */
  canSelfAuthorizeArchiveBySender: boolean;

  // --- Data & memory ---
  /**
   * May access long-term / cross-conversation memory — both the memory *tools*
   * (recall, retrospection, graph extraction) and *visibility*
   * of cross-conversation history in assembled context. Untrusted actors are
   * walled off from both.
   */
  canAccessMemory: boolean;
  /**
   * May perform privileged (non-conversation-scoped) document operations from
   * trust class alone. The effective decision also honors privileged channels —
   * see `canActOnPrivilegedDocuments` in `effective-capabilities.ts`.
   */
  canAccessPrivilegedDocuments: boolean;

  // --- Execution environment ---
  /**
   * May run the shell WITHOUT the untrusted sandbox (no credential-secrecy
   * confinement).
   */
  canRunUnsandboxedShell: boolean;

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
  canSelfAuthorizeArchiveBySender: true,
  canAccessMemory: true,
  canAccessPrivilegedDocuments: true,
  canRunUnsandboxedShell: true,
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
  canSelfAuthorizeArchiveBySender: false,
  canAccessMemory: false,
  canAccessPrivilegedDocuments: false,
  canRunUnsandboxedShell: false,
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
  canSelfAuthorizeArchiveBySender: false,
  canAccessMemory: false,
  canAccessPrivilegedDocuments: false,
  canRunUnsandboxedShell: false,
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
 *
 * The lookup uses an own-property check so raw values that name inherited
 * members (`"__proto__"`, `"constructor"`, `"toString"`) fail closed to the
 * `unknown` set rather than reading off `Object.prototype`.
 */
export function resolveCapabilities(
  trustClass: TrustClass | (string & {}) | undefined,
): CapabilitySet {
  if (
    trustClass != null &&
    Object.prototype.hasOwnProperty.call(CAPABILITIES_BY_CLASS, trustClass)
  ) {
    return CAPABILITIES_BY_CLASS[trustClass as TrustClass];
  }
  return UNKNOWN_CAPABILITIES;
}
