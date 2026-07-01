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
 * SHA-256 hash an invite token for storage comparison. Ported verbatim from
 * the assistant's `invite-store.ts` `hashToken`.
 */
export function hashInviteToken(rawToken: string): string {
  return sha256Hex(rawToken);
}

/**
 * SHA-256 hash a numeric invite/voice code for storage comparison. Ported
 * verbatim from the assistant's `voice-code.ts` `hashVoiceCode`.
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
 * Generate a cryptographically random numeric code of the given length.
 * Uses node:crypto randomInt for uniform distribution. Ported verbatim from
 * the assistant's `voice-code.ts` `generateVoiceCode`.
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

export const INVITE_REDEMPTION_RESULT_VALUES = [
  "redeemed",
  "already_member",
] as const;

export type InviteRedemptionResult =
  (typeof INVITE_REDEMPTION_RESULT_VALUES)[number];

/**
 * Result of a successful invite redemption resolved by the gateway. Carries
 * the identity fields the daemon needs to mirror the activation locally
 * (`already_member` = the sender was already an active member, so no invite
 * use was consumed).
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

/** IPC request for `redeem_invite_by_code` (6-digit invite code). */
export const RedeemInviteByCodeRequestSchema = z.object({
  code: z.string().min(1),
  sourceChannel: z.string().min(1),
  externalUserId: z.string().optional(),
  externalChatId: z.string().optional(),
  displayName: z.string().optional(),
  username: z.string().optional(),
});

export type RedeemInviteByCodeRequest = z.infer<
  typeof RedeemInviteByCodeRequestSchema
>;

/** IPC request for `redeem_invite_by_token` (raw link token). */
export const RedeemInviteByTokenRequestSchema = z.object({
  rawToken: z.string().min(1),
  sourceChannel: z.string().min(1),
  externalUserId: z.string().optional(),
  externalChatId: z.string().optional(),
  displayName: z.string().optional(),
  username: z.string().optional(),
});

export type RedeemInviteByTokenRequest = z.infer<
  typeof RedeemInviteByTokenRequestSchema
>;

/** IPC request for `redeem_voice_invite` (voice-channel spoken code). */
export const RedeemVoiceInviteRequestSchema = z.object({
  callerExternalUserId: z.string().min(1),
  code: z.string().min(1),
});

export type RedeemVoiceInviteRequest = z.infer<
  typeof RedeemVoiceInviteRequestSchema
>;

/** IPC request for `get_active_voice_invite`. */
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

/**
 * Daemon-bound `invite_redeemed` info-mirror event, fired best-effort by the
 * gateway after a successful redemption so the daemon can mirror the member
 * activation locally. Payload is the redemption outcome verbatim.
 */
export const InviteRedeemedNotificationSchema = InviteRedemptionOutcomeSchema;

export type InviteRedeemedNotification = z.infer<
  typeof InviteRedeemedNotificationSchema
>;
