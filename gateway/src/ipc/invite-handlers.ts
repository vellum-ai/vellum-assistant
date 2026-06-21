/**
 * IPC route definitions for gateway-canonical invite lifecycle.
 *
 * The assistant resolves the exact invite (caller-scoped) from a token/code,
 * passes its own validation, then CLAIMS the gateway-canonical row — BY ID —
 * via `record_invite_redemption` BEFORE mutating its own DB. That call
 * atomically gates on status="active" and consumes the row, so it is the single
 * authoritative lifecycle gate (no separate check-then-act window). This keeps
 * the gateway invite row authoritative across every runtime redemption path
 * (token + 6-digit channel intercepts, voice relay, HTTP).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Invite CRUD IPC contract (the daemon CLI relay — see contacts-gw-native-
 * invites PR 5 — calls these via `ipcCallPersistent`; KEEP STABLE):
 *
 *   invites_list
 *     params : { sourceChannel?: string; status?: string }
 *     returns: { invites: Array<Record<string, unknown>> }   (sanitized — no
 *              inviteCodeHash; gateway rows + voice join + assistant-only merge)
 *
 *   invites_create
 *     params : { contactId: string; sourceChannel: string; note?: string;
 *                maxUses?: number; expiresInMs?: number; contactName?: string;
 *                expectedExternalUserId?: string; voiceCodeDigits?: number;
 *                friendName?: string; guardianName?: string }
 *     returns: { invite: Record<string, unknown>; rawToken?: string }
 *              (the assistant's one-time minted payload)
 *
 *   invites_revoke
 *     params : { id: string }
 *     returns: { invite: Record<string, unknown> }            (sanitized)
 *
 *   invites_trigger_call
 *     params : { id: string }
 *     returns: { callSid: string }
 *
 * All four delegate to the SAME native functions the gateway HTTP invite
 * handlers use (gateway/src/http/routes/contacts-control-plane-proxy.ts), which
 * throw InviteNativeError / IpcHandlerError on failure. The IPC server
 * stringifies a thrown error into the wire `error` field.
 * ───────────────────────────────────────────────────────────────────────────
 */

import { z } from "zod";

import { ContactStore } from "../db/contact-store.js";
import {
  createInviteNative,
  listInvitesNative,
  revokeInviteNative,
  triggerInviteCallNative,
} from "../http/routes/contacts-control-plane-proxy.js";
import type { IpcRoute } from "./server.js";

let store: ContactStore | null = null;

function getStore(): ContactStore {
  if (!store) {
    store = new ContactStore();
  }
  return store;
}

const RecordInviteRedemptionParamsSchema = z.object({
  inviteId: z.string().min(1),
  redeemedByExternalUserId: z.string().nullish(),
  redeemedByExternalChatId: z.string().nullish(),
});

const positiveNumber = z
  .number()
  .refine((n) => Number.isFinite(n) && n > 0, "must be a positive number");

// The no-filter list is the common case; the daemon relay calls
// `ipcCallPersistent("invites_list")` with no params (req.params === undefined).
// The server validates req.params against this schema BEFORE the handler runs,
// so the schema must accept omitted/undefined params and default them to {}.
// Field validations stay intact for when params ARE provided.
const ListInvitesParamsSchema = z.preprocess(
  (v) => v ?? {},
  z.object({
    sourceChannel: z.string().optional(),
    status: z.string().optional(),
  }),
);

// Mirrors createInviteSchema in http/routes/invite-validation.ts.
const CreateInviteParamsSchema = z.object({
  contactId: z.string().trim().min(1, "contactId is required"),
  sourceChannel: z.string().trim().min(1, "sourceChannel is required"),
  note: z.string().optional(),
  maxUses: positiveNumber.optional(),
  expiresInMs: positiveNumber.optional(),
  contactName: z.string().optional(),
  expectedExternalUserId: z.string().optional(),
  voiceCodeDigits: positiveNumber.optional(),
  friendName: z.string().optional(),
  guardianName: z.string().optional(),
});

const InviteIdParamsSchema = z.object({
  id: z.string().min(1),
});

export const inviteRoutes: IpcRoute[] = [
  {
    // Authoritative redemption claim against the gateway-canonical row: bumps
    // useCount and flips status once exhausted, gated on status="active" so a
    // revoked/exhausted row can't be consumed under a race. `updated:false` on a
    // present row (`mirrored:true`) signals a rejected claim; `mirrored:false`
    // means the row is absent (legacy invite) — which is valid and must NOT
    // error.
    method: "record_invite_redemption",
    schema: RecordInviteRedemptionParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const parsed = RecordInviteRedemptionParamsSchema.parse(params);
      const result = getStore().recordInviteRedemption({
        inviteId: parsed.inviteId,
        redeemedByExternalUserId: parsed.redeemedByExternalUserId ?? null,
        redeemedByExternalChatId: parsed.redeemedByExternalChatId ?? null,
      });
      return {
        ok: true,
        updated: result.updated,
        mirrored: result.row !== null,
      };
    },
  },
  {
    // Gateway rows (lifecycle truth) + best-effort voice-field join +
    // assistant-only merge, sanitized (no inviteCodeHash). Shares the HTTP
    // list native implementation.
    method: "invites_list",
    schema: ListInvitesParamsSchema,
    handler: async (params?: Record<string, unknown>) => {
      const query = ListInvitesParamsSchema.parse(params ?? {});
      return await listInvitesNative(query);
    },
  },
  {
    // Verify contact → relay assistant mint → write canonical gateway row.
    // Returns the assistant's one-time minted payload + rawToken.
    method: "invites_create",
    schema: CreateInviteParamsSchema,
    handler: async (params?: Record<string, unknown>) => {
      const input = CreateInviteParamsSchema.parse(params);
      return await createInviteNative(input);
    },
  },
  {
    // Flip the gateway row (then mirror to assistant DB), or fall back to the
    // assistant-only row. Returns the sanitized invite.
    method: "invites_revoke",
    schema: InviteIdParamsSchema,
    handler: async (params?: Record<string, unknown>) => {
      const { id } = InviteIdParamsSchema.parse(params);
      return await revokeInviteNative(id);
    },
  },
  {
    // Gate on active gateway row → relay the outbound call to the assistant.
    method: "invites_trigger_call",
    schema: InviteIdParamsSchema,
    handler: async (params?: Record<string, unknown>) => {
      const { id } = InviteIdParamsSchema.parse(params);
      return await triggerInviteCallNative(id);
    },
  },
];
