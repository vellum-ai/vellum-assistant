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
 *   - the requester identity signals persisted on guardian access requests,
 *   - the signal-driven action list every card surface renders.
 *
 * The binding-strength ladder and `verified_via` constants are re-exported from
 * `@vellumai/gateway-client` (their canonical home, shared with the gateway ACL
 * write path that enforces demotion refusal — LUM-2505). Binding strength never
 * enters the capability layer — `trusted_contact` ≡ `unverified_contact` on
 * capabilities.
 */

import type { BindingStrength } from "@vellumai/gateway-client";
import {
  VERIFIED_VIA_CHANNEL_CLAIM,
  VERIFIED_VIA_MANUAL,
} from "@vellumai/gateway-client";

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
// Binding strength ladder (shared, gateway-owned)
// ---------------------------------------------------------------------------

// The binding-strength ladder and `verified_via` provenance constants are the
// canonical vocabulary in `@vellumai/gateway-client`
// (`binding-strength-contract.ts`); the gateway ACL write path enforces
// demotion refusal on the same values (LUM-2505). Re-exported here so
// introduction-card call sites keep importing them from this module.
export {
  bindingStrengthForVerifiedVia,
  VERIFIED_VIA_CHALLENGE,
} from "@vellumai/gateway-client";
export { VERIFIED_VIA_CHANNEL_CLAIM, VERIFIED_VIA_MANUAL };
export type { BindingStrength };

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
 *   workspace member / bot / voice:  [ Trust ] [ Deny ] [ Block ]
 *   external / stranger / guest:     [ Verify with a code ] [ Trust anyway ]
 *                                    [ Deny ] [ Block ]
 *
 * The `leave_unverified` action's label is mode-specific (see
 * {@link IntroductionModePolicy.leaveUnverifiedActionLabel}): a deny-path
 * request labels it "Deny" — clicking it sends the requester a decline notice
 * — while an admitted-mode nudge labels it "Leave unverified" (the admitted
 * sender keeps their floor-granted access and is never notified). The code
 * option is NEVER rendered for a bot.
 */
export function buildIntroductionActions(
  sourceChannel: string | undefined,
  signals: RequesterIdentitySignals,
  trigger?: string | null,
): IntroductionActionOption[] {
  const tail: IntroductionActionOption[] = [
    {
      id: "leave_unverified",
      label: introductionMode(trigger).leaveUnverifiedActionLabel,
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

// ---------------------------------------------------------------------------
// Introduction mode (what prompted the card)
// ---------------------------------------------------------------------------

/**
 * What prompted the introduction card. `denied` — the sender was refused
 * (ACL or admission floor) and the guardian decides whether to let them in.
 * `admitted` — the sender cleared the admission floor unclassified and the
 * guardian is nudged to set their trust level while the conversation
 * proceeds.
 */
export type AccessRequestTrigger = "denied" | "admitted";

/**
 * Per-mode policy for everything that differs between a deny-path access
 * request and an admitted-mode introduction nudge. Single source of truth:
 * copy, urgency, and the requester-facing lifecycle notice gates all read
 * from this table, so adding a mode means adding one entry — not another
 * branch per surface. Guardian-side decision semantics (the four actions,
 * ACL writes, dedup/suppression) never vary by mode.
 */
export interface IntroductionModePolicy {
  /** Attention-hint urgency for the guardian notification. */
  urgency: "medium" | "high";
  /** Card/notification title shared by every render surface. */
  cardTitle: string;
  /** Card subtitle (also the Slack card's no-preview body label). */
  cardSubtitle: string;
  /** questionText persisted on the guardian request row. */
  questionText: (senderIdentifier: string) => string;
  /** Contract-text identity line, given the assembled identity fragment. */
  identityLine: (identity: string) => string;
  /**
   * Requester-facing lifecycle notice gates. An admitted sender made no
   * request, so approved/denied/expired texts would misinform them.
   * `verify_code` delivery is intentionally NOT gated here — the guardian
   * explicitly chose a handshake, so the code must always reach the
   * requester.
   */
  notifyRequesterOnTrust: boolean;
  notifyRequesterOnDeny: boolean;
  notifyRequesterOnExpiry: boolean;
  /**
   * Button label for the `leave_unverified` action. Mode-specific because the
   * consequence differs: a deny-path request declines the requester (and
   * notifies them), so the label communicates that ("Deny"); an admitted-mode
   * nudge only declines to raise trust — the sender keeps their floor-granted
   * access and is not notified — so the neutral "Leave unverified" fits.
   */
  leaveUnverifiedActionLabel: string;
  /** Guardian confirmation for Leave unverified (desktop inline reply). */
  leaveUnverifiedGuardianReply: (requesterLabel: string) => string;
}

const INTRODUCTION_MODES: Record<AccessRequestTrigger, IntroductionModePolicy> =
  {
    denied: {
      urgency: "high",
      cardTitle: "Access Request",
      cardSubtitle: "Requesting access to the assistant",
      questionText: (senderIdentifier) =>
        `${senderIdentifier} is requesting access to the assistant`,
      identityLine: (identity) =>
        `${identity} is requesting access to the assistant.`,
      notifyRequesterOnTrust: true,
      notifyRequesterOnDeny: true,
      notifyRequesterOnExpiry: true,
      leaveUnverifiedActionLabel: "Deny",
      leaveUnverifiedGuardianReply: (requesterLabel) =>
        `${requesterLabel} will stay unverified. They won't be able to message the assistant.`,
    },
    admitted: {
      urgency: "medium",
      cardTitle: "New Contact",
      cardSubtitle: "Messaged your assistant — set their trust level",
      questionText: (senderIdentifier) =>
        `${senderIdentifier} messaged the assistant and was admitted — set their trust level`,
      identityLine: (identity) =>
        `${identity} messaged the assistant and was admitted under the channel's access setting — decide how much to trust them.`,
      notifyRequesterOnTrust: false,
      notifyRequesterOnDeny: false,
      notifyRequesterOnExpiry: false,
      leaveUnverifiedActionLabel: "Leave unverified",
      leaveUnverifiedGuardianReply: (requesterLabel) =>
        `${requesterLabel} will stay unverified.`,
    },
  };

/**
 * Resolve the mode policy from a payload or persisted trigger value.
 * Anything other than `"admitted"` (including NULL rows that predate the
 * trigger column) resolves to `denied` — the pre-existing behavior.
 */
export function introductionMode(
  trigger: string | null | undefined,
): IntroductionModePolicy {
  return INTRODUCTION_MODES[trigger === "admitted" ? "admitted" : "denied"];
}
