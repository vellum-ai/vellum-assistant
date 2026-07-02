/**
 * Shared invite contracts for the gateway-native invite lifecycle.
 *
 * Hash + generation helpers live here so gateway-computed hashes match
 * assistant-minted (and backfilled) hashes byte-for-byte — hash compatibility
 * with rows already stored in both DBs is load-bearing, so do not change the
 * scheme. The channel-gating allowlist and the redemption-outcome / invite
 * IPC schemas are shared so gateway and daemon converge on one source of
 * truth instead of drifting copies.
 */

import { createHash, randomBytes, randomInt } from "node:crypto";

import { z } from "zod";

// ---------------------------------------------------------------------------
// Hash + generation helpers
// ---------------------------------------------------------------------------

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * SHA-256 hash an invite token for storage comparison. Must remain stable:
 * stored invite rows hold hashes produced by this function.
 */
export function hashInviteToken(rawToken: string): string {
  return sha256Hex(rawToken);
}

/**
 * SHA-256 hash a numeric invite/voice code for storage comparison. Must
 * remain stable: stored invite rows hold hashes produced by this function.
 */
export function hashInviteCode(code: string): string {
  return sha256Hex(code);
}

/**
 * Generate a raw invite token: 32 bytes = 256 bits of entropy,
 * base64url-encoded to a 43-character URL-safe string.
 */
export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Basic E.164 phone number validation: starts with +, followed by 10-15
 * digits. Gates `expectedExternalUserId` on voice invites so the identity
 * binding is a real dialable number.
 */
export function isValidE164(phone: string): boolean {
  return /^\+\d{10,15}$/.test(phone);
}

/**
 * Generate a cryptographically random numeric code of the given length.
 * Uses node:crypto randomInt for uniform distribution.
 */
export function generateInviteCode(digits: number = 6): string {
  if (digits < 4 || digits > 10) {
    throw new Error(
      `Voice code digit count must be between 4 and 10, got ${digits}`,
    );
  }
  const min = Math.pow(10, digits - 1); // e.g. 100000 for 6 digits
  const max = Math.pow(10, digits); // e.g. 1000000 for 6 digits
  return String(randomInt(min, max));
}

// ---------------------------------------------------------------------------
// Channel gating
// ---------------------------------------------------------------------------

/**
 * Channels where inbound invite-code redemption is supported. Mirrors the
 * `invite.codeRedemptionEnabled` flags in the assistant's channel policy
 * registry (`assistant/src/channels/config.ts`), which delegates here so
 * gateway and daemon share one allowlist.
 */
export const INVITE_CODE_REDEMPTION_CHANNELS: ReadonlySet<string> = new Set([
  "telegram",
  "whatsapp",
  "slack",
  "email",
]);

/** Whether invite code redemption is enabled for the given channel. */
export function isInviteCodeRedemptionEnabled(channelType: string): boolean {
  return INVITE_CODE_REDEMPTION_CHANNELS.has(channelType);
}

// ---------------------------------------------------------------------------
// Redemption outcome
// ---------------------------------------------------------------------------

const INVITE_REDEMPTION_RESULT_VALUES = ["redeemed", "already_member"] as const;

export type InviteRedemptionResult =
  (typeof INVITE_REDEMPTION_RESULT_VALUES)[number];

/**
 * Result of a successful invite redemption resolved by the gateway. Carries
 * the identity fields the daemon needs to mirror the activation locally
 * (`already_member` = the sender was already an active member, so no invite
 * use was consumed). Also the payload of the best-effort daemon IPC
 * `invite_redeemed` info-mirror event, verbatim.
 */
export const InviteRedemptionOutcomeSchema = z.object({
  inviteId: z.string(),
  contactId: z.string(),
  sourceChannel: z.string(),
  memberExternalUserId: z.string(),
  memberExternalChatId: z.string().optional(),
  displayName: z.string().optional(),
  username: z.string().optional(),
  // Opaque passthrough — the gateway stores but never interprets it.
  sourceConversationId: z.string().optional(),
  result: z.enum(INVITE_REDEMPTION_RESULT_VALUES),
});

export type InviteRedemptionOutcome = z.infer<
  typeof InviteRedemptionOutcomeSchema
>;

// ---------------------------------------------------------------------------
// IPC schemas
// ---------------------------------------------------------------------------
//
// The schemas below define the gateway-native invite redemption IPC surface.
// Schema-to-method mapping:
//
// - `RedeemInviteByCodeRequestSchema` / `RedeemInviteByTokenRequestSchema` —
//   request shapes for the gateway redemption engine (code and link-token
//   redemption).
// - `RedeemVoiceInviteRequestSchema` — gateway IPC `redeem_voice_invite`.
// - `GetActiveVoiceInviteRequestSchema` — gateway IPC
//   `get_active_voice_invite`.
//
// Wire dispatch for `invites_redeem` (gateway IPC + HTTP redeem): the presence
// of `code` selects voice redemption (validated by
// `RedeemVoiceInviteRequestSchema`); otherwise the body is a link-token
// redemption (validated by `RedeemInviteByTokenRequestSchema`).

/**
 * Gateway redemption-engine request for code redemption (6-digit code).
 * Not an `invites_redeem` wire shape: bare-code redemption only happens via
 * the gateway inbound intercept, which supplies the sender identity itself.
 */
export const RedeemInviteByCodeRequestSchema = z.object({
  code: z.string().min(1),
  sourceChannel: z.string().trim().min(1),
  externalUserId: z.string().optional(),
  externalChatId: z.string().optional(),
  displayName: z.string().optional(),
  username: z.string().optional(),
});

export type RedeemInviteByCodeRequest = z.infer<
  typeof RedeemInviteByCodeRequestSchema
>;

/**
 * Gateway redemption-engine request for token redemption. `token` is the raw
 * link token as sent on the `invites_redeem` wire by the CLI and the daemon
 * relay.
 */
export const RedeemInviteByTokenRequestSchema = z.object({
  token: z.string().min(1),
  sourceChannel: z.string().trim().min(1),
  externalUserId: z.string().optional(),
  externalChatId: z.string().optional(),
  displayName: z.string().optional(),
  username: z.string().optional(),
});

export type RedeemInviteByTokenRequest = z.infer<
  typeof RedeemInviteByTokenRequestSchema
>;

/**
 * Request for gateway IPC `redeem_voice_invite` (voice-channel spoken code).
 * Also the `invites_redeem` voice wire shape, selected by the presence of
 * `code`.
 */
export const RedeemVoiceInviteRequestSchema = z.object({
  callerExternalUserId: z.string().min(1),
  code: z.string().min(1),
});

export type RedeemVoiceInviteRequest = z.infer<
  typeof RedeemVoiceInviteRequestSchema
>;

/** Request for gateway IPC `get_active_voice_invite`. */
export const GetActiveVoiceInviteRequestSchema = z.object({
  callerExternalUserId: z.string().min(1),
});

export type GetActiveVoiceInviteRequest = z.infer<
  typeof GetActiveVoiceInviteRequestSchema
>;

/**
 * Active voice invite awaiting the expected caller — display metadata for
 * the personalized voice prompt; never carries the code or its hash.
 */
export const ActiveVoiceInviteSchema = z.object({
  inviteId: z.string(),
  inviteeName: z.string().nullable(),
  guardianName: z.string().nullable(),
  codeDigits: z.number().int(),
});

export type ActiveVoiceInvite = z.infer<typeof ActiveVoiceInviteSchema>;
