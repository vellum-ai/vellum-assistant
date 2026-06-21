/**
 * IPC route definitions for gateway-canonical invite lifecycle.
 *
 * The assistant resolves the exact invite (caller-scoped) from a token/code,
 * then asks the gateway — BY ID — whether that invite is still redeemable
 * (`check_invite_active`) before mutating, and mirrors the redemption back into
 * the gateway row afterwards (`record_invite_redemption`). This keeps the
 * gateway invite row authoritative across every runtime redemption path
 * (token + 6-digit channel intercepts, voice relay, HTTP).
 */

import { z } from "zod";

import { ContactStore } from "../db/contact-store.js";
import type { IpcRoute } from "./server.js";

let store: ContactStore | null = null;

function getStore(): ContactStore {
  if (!store) {
    store = new ContactStore();
  }
  return store;
}

const CheckInviteActiveParamsSchema = z.object({
  inviteId: z.string().min(1),
});

const RecordInviteRedemptionParamsSchema = z.object({
  inviteId: z.string().min(1),
  redeemedByExternalUserId: z.string().nullish(),
  redeemedByExternalChatId: z.string().nullish(),
});

export const inviteRoutes: IpcRoute[] = [
  {
    // Resolve, by id, whether the gateway-canonical invite row is still
    // redeemable. `exists` distinguishes a legacy assistant-only invite (no
    // gateway row → assistant stays authoritative) from a gateway-known invite
    // that has been revoked/exhausted/expired (`active:false` → reject).
    method: "check_invite_active",
    schema: CheckInviteActiveParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const { inviteId } = CheckInviteActiveParamsSchema.parse(params);
      const row = getStore().getInviteById(inviteId);
      if (!row) {
        return { exists: false, active: false };
      }
      const active =
        row.status === "active" &&
        row.expiresAt > Date.now() &&
        row.useCount < row.maxUses;
      return { exists: true, active };
    },
  },
  {
    // Mirror a redemption into the gateway-canonical row. No-ops (updated:false)
    // when the row is absent (legacy invite) or no longer active — legacy
    // invites are valid, so an absent row must NOT error.
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
];
