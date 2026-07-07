/**
 * Gateway-backed invite client.
 *
 * Typed async wrappers over the gateway's invite IPC routes
 * (`gateway/src/ipc/invite-handlers.ts`). The gateway owns the canonical
 * invite lifecycle — mint, list, revoke, redemption — against
 * `ingress_invites`; the daemon relays its CLI/HTTP invite surfaces here and
 * layers presentation fields on afterwards. Responses are validated against
 * the shared contract schemas in `@vellumai/gateway-client` — the same
 * schemas the gateway routes are pinned to.
 *
 * Error posture (fail-closed — there is no local fallback): every wrapper
 * THROWS on transport failure or a malformed response. An `IpcCallError`
 * keeps the gateway's statusCode/errorCode so relay routes surface 4xx
 * engine reasons as 4xx. Voice-call invite detection/redemption does NOT
 * live here: the hot call-setup path uses `calls/gateway-invite-reader.ts`
 * (one-shot `ipcCall`, explicit short timeouts, fail-soft detection) instead
 * of the persistent client these control-plane relays share.
 */

import {
  CreateInviteIpcResponseSchema,
  INVITES_IPC_METHODS,
  type InviteWire,
  ListInvitesIpcResponseSchema,
  type RedeemInviteByTokenRequest,
  type RedeemInviteTokenIpcResponse,
  RedeemInviteTokenIpcResponseSchema,
  type RedeemInviteVoiceIpcResponse,
  RedeemInviteVoiceIpcResponseSchema,
  type RedeemVoiceInviteRequest,
  RevokeInviteIpcResponseSchema,
} from "@vellumai/gateway-client";

import { ipcCallPersistentValidated } from "../ipc/gateway-validated-call.js";

export type { InviteWire } from "@vellumai/gateway-client";

export interface ListInvitesFilters {
  sourceChannel?: string;
  status?: string;
}

/** List sanitized gateway invite rows, optionally filtered. */
export async function listInvites(
  filters: ListInvitesFilters = {},
): Promise<InviteWire[]> {
  const response = await ipcCallPersistentValidated(
    INVITES_IPC_METHODS.list,
    {
      ...(filters.sourceChannel
        ? { sourceChannel: filters.sourceChannel }
        : {}),
      ...(filters.status ? { status: filters.status } : {}),
    },
    ListInvitesIpcResponseSchema,
  );
  return response.invites;
}

/**
 * Create-invite params. Field validation is gateway-owned
 * (`gateway/src/http/routes/invite-validation.ts`) — invalid input surfaces
 * as a relayed 400.
 */
export interface CreateInviteParams {
  contactId: string;
  sourceChannel?: string;
  note?: string;
  maxUses?: number;
  expiresInMs?: number;
  expectedExternalUserId?: string;
  guardianName?: string;
  sourceConversationId?: string;
}

/**
 * Mint an invite. Returns the gateway's one-time payload — row fields plus
 * the plaintext secrets (`rawToken` for link invites), never fetchable later.
 */
export async function createInvite(
  params: CreateInviteParams,
): Promise<{ invite: InviteWire; rawToken?: string }> {
  return ipcCallPersistentValidated(
    INVITES_IPC_METHODS.create,
    { ...params },
    CreateInviteIpcResponseSchema,
  );
}

/** Revoke an invite (idempotent for already-terminal invites). */
export async function revokeInvite(id: string): Promise<InviteWire> {
  const response = await ipcCallPersistentValidated(
    INVITES_IPC_METHODS.revoke,
    { id },
    RevokeInviteIpcResponseSchema,
  );
  return response.invite;
}

/**
 * Redeem a link-token invite (`invites_redeem`, token branch — selected by
 * the absence of `code`). Engine failures throw a relayed 400 with the
 * engine reason.
 */
export async function redeemInviteByToken(
  params: RedeemInviteByTokenRequest,
): Promise<RedeemInviteTokenIpcResponse> {
  return ipcCallPersistentValidated(
    INVITES_IPC_METHODS.redeem,
    params as unknown as Record<string, unknown>,
    RedeemInviteTokenIpcResponseSchema,
  );
}

/**
 * Redeem a spoken voice code (`invites_redeem`, voice branch — selected by
 * the presence of `code`). `assistantId` is a daemon passthrough.
 */
export async function redeemInviteByVoiceCode(
  params: RedeemVoiceInviteRequest & { assistantId?: string },
): Promise<RedeemInviteVoiceIpcResponse> {
  return ipcCallPersistentValidated(
    INVITES_IPC_METHODS.redeem,
    params as unknown as Record<string, unknown>,
    RedeemInviteVoiceIpcResponseSchema,
  );
}
