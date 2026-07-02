/**
 * Pure, side-effect-free validation helpers for invite request bodies.
 *
 * These mirror the daemon's invite request shapes
 * (`assistant/src/runtime/routes/contact-routes.ts`, operations
 * `invites_create` / `invites_redeem`) so the gateway HTTP handlers and IPC
 * callers share a single source of validation truth.
 *
 * No DB, no IPC, no logging — just parse/validate. Keep it that way so any
 * caller (handler or test) can use these directly.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Create invite
// ---------------------------------------------------------------------------

export interface CreateInviteInput {
  contactId: string;
  sourceChannel: string;
  note?: string;
  maxUses?: number;
  expiresInMs?: number;
  expectedExternalUserId?: string;
  // Daemon-supplied passthrough fields — the gateway stores them on the
  // invite row and never interprets them.
  guardianName?: string;
  sourceConversationId?: string;
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

export const positiveNumber = z
  .number()
  .refine((n) => Number.isFinite(n) && n > 0, "must be a positive number");

export const createInviteSchema = z.object({
  contactId: z.string().trim().min(1, "contactId is required"),
  sourceChannel: z.string().trim().min(1, "sourceChannel is required"),
  note: z.string().optional(),
  maxUses: positiveNumber.optional(),
  expiresInMs: positiveNumber.optional(),
  expectedExternalUserId: z.string().optional(),
  guardianName: z.string().optional(),
  sourceConversationId: z.string().optional(),
});

function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) {
    return "Invalid request body";
  }
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

export function parseCreateInviteBody(
  body: unknown,
): ParseResult<CreateInviteInput> {
  const parsed = createInviteSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return { ok: false, message: firstIssueMessage(parsed.error) };
  }
  return { ok: true, value: parsed.data };
}

// ---------------------------------------------------------------------------
// Redeem invite (voice-code vs token)
// ---------------------------------------------------------------------------

export interface VoiceRedeemInput {
  kind: "voice";
  code: string;
  callerExternalUserId: string;
  assistantId?: string;
}

export interface TokenRedeemInput {
  kind: "token";
  token: string;
  externalUserId?: string;
  externalChatId?: string;
  sourceChannel: string;
}

export type RedeemInviteInput = VoiceRedeemInput | TokenRedeemInput;

export function parseRedeemInviteBody(
  body: unknown,
): ParseResult<RedeemInviteInput> {
  const raw = (body ?? {}) as Record<string, unknown>;

  // Voice-code path: presence of `code` selects voice redemption (matching the
  // daemon, which branches on `body.code != null`).
  if (raw.code != null) {
    const code = typeof raw.code === "string" ? raw.code : "";
    const callerExternalUserId =
      typeof raw.callerExternalUserId === "string"
        ? raw.callerExternalUserId
        : "";
    if (!code || !callerExternalUserId) {
      return {
        ok: false,
        message: "callerExternalUserId and code are required",
      };
    }
    return {
      ok: true,
      value: {
        kind: "voice",
        code,
        callerExternalUserId,
        assistantId:
          typeof raw.assistantId === "string" ? raw.assistantId : undefined,
      },
    };
  }

  // Token path.
  const token = typeof raw.token === "string" ? raw.token : "";
  if (!token) {
    return { ok: false, message: "token is required" };
  }
  const sourceChannel =
    typeof raw.sourceChannel === "string" ? raw.sourceChannel.trim() : "";
  if (!sourceChannel) {
    return { ok: false, message: "sourceChannel is required" };
  }
  return {
    ok: true,
    value: {
      kind: "token",
      token,
      externalUserId:
        typeof raw.externalUserId === "string" ? raw.externalUserId : undefined,
      externalChatId:
        typeof raw.externalChatId === "string" ? raw.externalChatId : undefined,
      sourceChannel,
    },
  };
}

// ---------------------------------------------------------------------------
// List invites query
// ---------------------------------------------------------------------------

export const listInviteQueryShape = {
  sourceChannel: z.string().optional(),
  status: z.string().optional(),
} as const;

export const listInviteQuerySchema = z.object(listInviteQueryShape);

export interface ListInviteQuery {
  sourceChannel?: string;
  status?: string;
}

export function parseListInviteQuery(
  searchParams: URLSearchParams,
): ListInviteQuery {
  const sourceChannel = searchParams.get("sourceChannel") ?? undefined;
  const status = searchParams.get("status") ?? undefined;
  return {
    ...(sourceChannel ? { sourceChannel } : {}),
    ...(status ? { status } : {}),
  };
}
