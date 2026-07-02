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
 * Invite CRUD IPC contract (the daemon CLI relay calls these via
 * `ipcCallPersistent`; KEEP STABLE):
 *
 *   invites_list
 *     params : { sourceChannel?: string; status?: string }
 *     returns: { invites: Array<Record<string, unknown>> }   (sanitized — no
 *              inviteCodeHash; gateway rows + voice join + assistant-only merge)
 *
 *   invites_create
 *     params : { contactId: string; sourceChannel: string; note?: string;
 *                maxUses?: number; expiresInMs?: number;
 *                expectedExternalUserId?: string; guardianName?: string;
 *                sourceConversationId?: string }
 *     returns: { invite: Record<string, unknown>; rawToken?: string }
 *              (the gateway's one-time minted payload — row fields plus the
 *              plaintext token/inviteCode/voiceCode, never fetchable later)
 *
 *   invites_revoke
 *     params : { id: string }
 *     returns: { invite: Record<string, unknown> }            (sanitized)
 *
 *   get_active_voice_invite
 *     params : { callerExternalUserId: string }
 *     returns: { invite: ActiveVoiceInvite | null }           (display metadata
 *              only — inviteId/inviteeName/guardianName/codeDigits; never the
 *              code or its hash)
 *
 *   redeem_voice_invite
 *     params : { callerExternalUserId: string; code: string }
 *     returns: { ok: true; outcome: InviteRedemptionOutcome } on
 *              redeemed/already_member, or
 *              { ok: false; reason: "invalid_or_expired" }    (single generic
 *              failure — never leaks which check refused)
 *
 * (Note: invites_trigger_call is NOT relayed here — it stays daemon-local on the
 * assistant. The gateway HTTP call path validates its row then delegates the
 * provider call to the assistant via triggerInviteCallNative; relaying it back
 * over IPC would loop gateway→assistant→gateway.)
 *
 * All three delegate to the SAME native functions the gateway HTTP invite
 * handlers use (gateway/src/http/routes/contacts-control-plane-proxy.ts), which
 * throw InviteNativeError / IpcHandlerError on failure. The IPC server
 * stringifies a thrown error into the wire `error` field.
 * ───────────────────────────────────────────────────────────────────────────
 */

import {
  GetActiveVoiceInviteRequestSchema,
  RedeemVoiceInviteRequestSchema,
} from "@vellumai/gateway-client";
import { z } from "zod";

import { ContactStore } from "../db/contact-store.js";
import {
  createInviteNative,
  listInvitesNative,
  revokeInviteNative,
} from "../http/routes/contacts-control-plane-proxy.js";
import {
  createInviteSchema,
  listInviteQueryShape,
} from "../http/routes/invite-validation.js";
import {
  getActiveVoiceInviteForCaller,
  notifyDaemonInviteRedeemed,
  redeemVoiceInvite,
} from "../verification/invite-redemption.js";
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

// The no-filter list is the common case; the daemon relay calls
// `ipcCallPersistent("invites_list")` with no params (req.params === undefined).
// The server validates req.params against this schema BEFORE the handler runs,
// so the schema must accept omitted/undefined params and default them to {}.
// Field validations stay intact for when params ARE provided. The omitted-params
// tolerance is the IPC-layer concern; the field shape is shared with the HTTP
// list-query validator.
const ListInvitesParamsSchema = z.preprocess(
  (v) => v ?? {},
  z.object(listInviteQueryShape),
);

// The gateway HTTP handlers and IPC callers share a single create-invite schema.
const CreateInviteParamsSchema = createInviteSchema;

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
    // Verify contact → mint secrets natively → write the canonical gateway
    // row. Returns the gateway's one-time minted payload + rawToken.
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
    // Voice-invite detection for an inbound caller: the active phone invite
    // bound to the caller's number, projected to display metadata only.
    method: "get_active_voice_invite",
    schema: GetActiveVoiceInviteRequestSchema,
    handler: (params?: Record<string, unknown>) => {
      const { callerExternalUserId } =
        GetActiveVoiceInviteRequestSchema.parse(params);
      return {
        invite: getActiveVoiceInviteForCaller(callerExternalUserId, getStore()),
      };
    },
  },
  {
    // Voice-code redemption through the gateway engine. Success fires the
    // best-effort `invite_redeemed` daemon info-mirror event (already_member
    // consumed nothing, so there is nothing to mirror).
    method: "redeem_voice_invite",
    schema: RedeemVoiceInviteRequestSchema,
    handler: async (params?: Record<string, unknown>) => {
      const parsed = RedeemVoiceInviteRequestSchema.parse(params);
      const result = await redeemVoiceInvite({ ...parsed, store: getStore() });
      if (result.status === "failed") {
        return { ok: false, reason: result.reason };
      }
      if (result.status === "redeemed") {
        notifyDaemonInviteRedeemed(result.outcome);
      }
      return { ok: true, outcome: result.outcome };
    },
  },
];
