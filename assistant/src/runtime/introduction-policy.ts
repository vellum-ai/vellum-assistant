/**
 * Introduction-card policy (Lane A trust-setting).
 *
 * When a new contact first appears, the guardian resolves their trust level on
 * a single introduction card with four outcomes:
 *
 *   | Action             | Outcome              | verifiedVia              |
 *   | ------------------ | -------------------- | ------------------------ |
 *   | `trust`            | trusted_contact      | manual / channel-claim   |
 *   | `verify_code`      | trusted_contact      | challenge (post-handshake) |
 *   | `leave_unverified` | unverified_contact   | —                        |
 *   | `block`            | revoked              | —                        |
 *
 * The verification handshake is a signal-driven exception, not the default:
 * which actions are offered (and which leads) is derived from the platform's
 * own identity confidence — never from per-individual-contact rules.
 *
 * This module is the single source of truth for:
 *   - the requester identity signals persisted on canonical access requests,
 *   - the binding-strength ladder derived from `verifiedVia` provenance,
 *   - the signal-driven action list every card surface renders.
 *
 * Binding strength is provenance/audit only — it never enters the capability
 * layer (`trusted_contact` ≡ `unverified_contact` on capabilities).
 */

import type { ApprovalAction } from "./channel-approval-types.js";

// ---------------------------------------------------------------------------
// Requester identity signals
// ---------------------------------------------------------------------------

/**
 * Platform-provided identity signals for the requester, captured at
 * access-request creation so decision-time policy (binding strength, bot
 * coercion) reads the same facts the card was rendered from.
 *
 * Each signal is tri-state: `true` / `false` are positive platform
 * resolutions (Slack `users.info` succeeded and said so); `undefined` means
 * the platform could not vouch either way (lookup failure, channel without
 * workspace identity). Policy must treat `undefined` as NOT vouched.
 */
export interface RequesterIdentitySignals {
  /** The requester is a bot / integration account (Slack `is_bot`, Telegram `is_bot`). */
  isBot?: boolean;
  /** Slack: external user from another workspace (Slack Connect). */
  isStranger?: boolean;
  /** Slack: guest / restricted account. */
  isRestricted?: boolean;
}

const SIGNAL_KEYS = [
  "isBot",
  "isStranger",
  "isRestricted",
] as const satisfies ReadonlyArray<keyof RequesterIdentitySignals>;

/**
 * Coerce an untrusted value to a tri-state identity-signal boolean: explicit
 * booleans pass through (both are positive platform resolutions), everything
 * else is unknown. Shared by the persisted-signal parser and the
 * access-request payload schema so the tri-state rule cannot drift.
 */
export function coerceSignalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function compactSignals(
  record: Partial<Record<(typeof SIGNAL_KEYS)[number], unknown>>,
): RequesterIdentitySignals {
  const compact: RequesterIdentitySignals = {};
  for (const key of SIGNAL_KEYS) {
    const value = coerceSignalBoolean(record[key]);
    if (value !== undefined) {
      compact[key] = value;
    }
  }
  return compact;
}

/**
 * Serialize signals for the `requester_signals` column. Explicit `false` is
 * preserved — it is a positive "platform vouches this is a regular member"
 * fact, distinct from an absent (unknown) signal. Returns undefined when no
 * signal was resolved at all.
 */
export function serializeRequesterSignals(
  signals: RequesterIdentitySignals,
): string | undefined {
  const compact = compactSignals(signals);
  return Object.keys(compact).length > 0 ? JSON.stringify(compact) : undefined;
}

/** Parse the persisted `requester_signals` column. Malformed values fail closed to no signals. */
export function parseRequesterSignals(
  raw: string | null | undefined,
): RequesterIdentitySignals {
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    return compactSignals(parsed as Record<string, unknown>);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Binding strength ladder
// ---------------------------------------------------------------------------

/**
 * Binding-strength ladder: how strongly the contact's channel identity is
 * bound to the person/agent the guardian believes they are.
 *
 *   verified_handshake > internal_workspace_match > inbound_channel_claim
 *
 * - `verified_handshake` — the contact proved control of the channel by
 *   returning a verification code (`verifiedVia: "challenge"`).
 * - `internal_workspace_match` — the platform already authenticated the
 *   identity inside the guardian's own workspace (Slack member or workspace
 *   app); the guardian vouches directly (`verifiedVia: "manual"`).
 * - `inbound_channel_claim` — the guardian trusts an identity the platform is
 *   NOT vouching for (external / Slack-Connect / restricted guest / channels
 *   without workspace identity). Recorded as
 *   `verifiedVia: "manual_channel_claim"` so a trusted-anyway external never
 *   carries the same provenance as a code-verified contact.
 */
export type BindingStrength =
  | "verified_handshake"
  | "internal_workspace_match"
  | "inbound_channel_claim";

/** verifiedVia written when the guardian direct-trusts a workspace-vouched identity. */
export const VERIFIED_VIA_MANUAL = "manual";

/** verifiedVia written when the guardian trusts an identity the platform is not vouching for. */
export const VERIFIED_VIA_CHANNEL_CLAIM = "manual_channel_claim";

/** verifiedVia written by the gateway when a verification code is redeemed. */
export const VERIFIED_VIA_CHALLENGE = "challenge";

/**
 * Derive the binding strength recorded by a `verifiedVia` provenance value.
 * Returns null for provenance outside the introduction ladder (e.g. "invite",
 * "bootstrap"), which predate it and keep their own audit meaning.
 */
export function bindingStrengthForVerifiedVia(
  verifiedVia: string | null | undefined,
): BindingStrength | null {
  switch (verifiedVia) {
    case VERIFIED_VIA_CHALLENGE:
      return "verified_handshake";
    case VERIFIED_VIA_MANUAL:
      return "internal_workspace_match";
    case VERIFIED_VIA_CHANNEL_CLAIM:
      return "inbound_channel_claim";
    default:
      return null;
  }
}

/**
 * Whether the platform itself vouches for the requester's identity inside the
 * guardian's workspace. Only Slack carries workspace identity today: a
 * non-stranger, non-restricted member (human or workspace app) is
 * authenticated by Slack. Every other channel is an inbound channel claim.
 *
 * Requires POSITIVE signals: `isStranger` and `isRestricted` must be an
 * explicit `false` (Slack `users.info` resolved the user and vouched).
 * Absent signals — a lookup failure or timeout — fail toward NOT vouched, so
 * a Slack-Connect user in a degraded path never gets a one-tap Trust default
 * or `manual` (workspace-match) provenance.
 */
export function isWorkspaceVouchedIdentity(
  sourceChannel: string | undefined,
  signals: RequesterIdentitySignals,
): boolean {
  return (
    sourceChannel === "slack" &&
    signals.isStranger === false &&
    signals.isRestricted === false
  );
}

/**
 * Resolve the trust-decision binding for a direct **Trust** action: the
 * binding strength the decision records and the `verifiedVia` provenance that
 * persists it. A trusted-anyway external must NOT record
 * `verified_handshake`-equivalent provenance.
 */
export function resolveTrustBinding(
  sourceChannel: string | undefined,
  signals: RequesterIdentitySignals,
): { bindingStrength: BindingStrength; verifiedVia: string } {
  if (isWorkspaceVouchedIdentity(sourceChannel, signals)) {
    return {
      bindingStrength: "internal_workspace_match",
      verifiedVia: VERIFIED_VIA_MANUAL,
    };
  }
  return {
    bindingStrength: "inbound_channel_claim",
    verifiedVia: VERIFIED_VIA_CHANNEL_CLAIM,
  };
}

// ---------------------------------------------------------------------------
// Signal-driven action list
// ---------------------------------------------------------------------------

/**
 * A single introduction-card action option, shared by every card renderer.
 * `emphasis` is the surface-agnostic weight each renderer translates to its
 * platform token (Slack `primary`/`danger`, Surface `primary`/`destructive`),
 * so the emphasis policy lives here rather than per renderer.
 */
export interface IntroductionActionOption {
  id: Extract<
    ApprovalAction,
    "trust" | "verify_code" | "leave_unverified" | "block"
  >;
  label: string;
  emphasis: "primary" | "secondary" | "destructive";
}

/**
 * Whether the verification handshake is offered for this requester.
 *
 * The handshake is the exception, not the default:
 * - never for bots/integrations — a bot cannot return a code;
 * - not for workspace-vouched identities — the platform already
 *   authenticated them;
 * - not on voice — a phone call has no text handshake path;
 * - offered everywhere else: it leads for identities nobody is vouching for.
 */
export function isHandshakeOffered(
  sourceChannel: string | undefined,
  signals: RequesterIdentitySignals,
): boolean {
  if (signals.isBot === true) {
    return false;
  }
  if (sourceChannel === "phone") {
    return false;
  }
  return !isWorkspaceVouchedIdentity(sourceChannel, signals);
}

/**
 * Build the ordered introduction-card action list for a requester. The first
 * action is the emphasized default:
 *
 *   workspace member / bot / voice:  [ Trust ] [ Leave unverified ] [ Block ]
 *   external / stranger / guest:     [ Verify with a code ] [ Trust anyway ]
 *                                    [ Leave unverified ] [ Block ]
 *
 * The code option is NEVER rendered for a bot.
 */
export function buildIntroductionActions(
  sourceChannel: string | undefined,
  signals: RequesterIdentitySignals,
): IntroductionActionOption[] {
  const tail: IntroductionActionOption[] = [
    {
      id: "leave_unverified",
      label: "Leave unverified",
      emphasis: "secondary",
    },
    { id: "block", label: "Block", emphasis: "destructive" },
  ];
  if (isHandshakeOffered(sourceChannel, signals)) {
    return [
      { id: "verify_code", label: "Verify with a code", emphasis: "primary" },
      { id: "trust", label: "Trust anyway", emphasis: "secondary" },
      ...tail,
    ];
  }
  return [{ id: "trust", label: "Trust", emphasis: "primary" }, ...tail];
}
