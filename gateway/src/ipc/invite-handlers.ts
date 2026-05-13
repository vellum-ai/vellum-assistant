/**
 * IPC route definitions for invite mirroring.
 *
 * Direction: assistant daemon → gateway. The daemon owns invite creation
 * during Track B PR-B-1: it generates the token / voice-code / invite-code,
 * resolves channel adapters, and runs the LLM-driven guardian-instruction
 * builder. After persisting to its own `assistant_ingress_invites` table,
 * the daemon calls this handler to populate the gateway's mirror row.
 *
 * Failure policy: the handler logs and re-raises. The daemon-side call site
 * is best-effort (`.catch(log.warn)`) so a mirror failure never breaks the
 * authoritative write.
 */

import { z } from "zod";

import { InviteStore } from "../db/invite-store.js";
import { getLogger } from "../logger.js";
import type { IpcRoute } from "./server.js";

const log = getLogger("invite-handlers");

let store: InviteStore | null = null;

function getStore(): InviteStore {
  if (!store) {
    store = new InviteStore();
  }
  return store;
}

/**
 * Reset the cached store. Tests inject their own DB by clearing the
 * singleton between cases.
 */
export function _resetInviteStoreForTests(): void {
  store = null;
}

const MirrorInviteCreateParamsSchema = z.object({
  id: z.string().min(1),
  sourceChannel: z.string().min(1),
  tokenHash: z.string().min(1),
  sourceConversationId: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  maxUses: z.number().int().min(1),
  useCount: z.number().int().min(0),
  expiresAt: z.number().int(),
  status: z.enum(["active", "redeemed", "revoked", "expired"]),
  redeemedByExternalUserId: z.string().nullable().optional(),
  redeemedByExternalChatId: z.string().nullable().optional(),
  redeemedAt: z.number().int().nullable().optional(),
  expectedExternalUserId: z.string().nullable().optional(),
  voiceCodeHash: z.string().nullable().optional(),
  voiceCodeDigits: z.number().int().nullable().optional(),
  inviteCodeHash: z.string().nullable().optional(),
  friendName: z.string().nullable().optional(),
  guardianName: z.string().nullable().optional(),
  contactId: z.string().min(1),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export const inviteRoutes: IpcRoute[] = [
  {
    method: "mirror_invite_create",
    schema: MirrorInviteCreateParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const parsed = MirrorInviteCreateParamsSchema.parse(params);
      try {
        const row = getStore().mirrorCreate({
          ...parsed,
          sourceConversationId: parsed.sourceConversationId ?? null,
          note: parsed.note ?? null,
          redeemedByExternalUserId: parsed.redeemedByExternalUserId ?? null,
          redeemedByExternalChatId: parsed.redeemedByExternalChatId ?? null,
          redeemedAt: parsed.redeemedAt ?? null,
          expectedExternalUserId: parsed.expectedExternalUserId ?? null,
          voiceCodeHash: parsed.voiceCodeHash ?? null,
          voiceCodeDigits: parsed.voiceCodeDigits ?? null,
          inviteCodeHash: parsed.inviteCodeHash ?? null,
          friendName: parsed.friendName ?? null,
          guardianName: parsed.guardianName ?? null,
        });
        log.info(
          {
            inviteId: row.id,
            sourceChannel: row.sourceChannel,
            contactId: row.contactId,
            status: row.status,
          },
          "mirror_invite_create: gateway mirror row written",
        );
        return { id: row.id };
      } catch (err) {
        log.error(
          {
            err,
            inviteId: parsed.id,
            sourceChannel: parsed.sourceChannel,
            contactId: parsed.contactId,
          },
          "mirror_invite_create: gateway mirror write failed",
        );
        throw err;
      }
    },
  },
];
