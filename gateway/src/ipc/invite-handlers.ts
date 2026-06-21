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

const RecordInviteRedemptionParamsSchema = z.object({
  inviteId: z.string().min(1),
  redeemedByExternalUserId: z.string().nullish(),
  redeemedByExternalChatId: z.string().nullish(),
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
];
