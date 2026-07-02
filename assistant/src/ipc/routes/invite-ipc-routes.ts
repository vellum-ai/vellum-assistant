/**
 * IPC-only invite methods called by the gateway's native invite HTTP
 * handlers over the assistant IPC socket (`ipcCallAssistant`).
 *
 * The gateway redeems codes here while redemption remains daemon-local.
 * These have no HTTP surface: they are registered directly on the IPC
 * server and never enter the shared `ROUTES` array, so they can never
 * reach the gateway's HTTP IPC proxy route schema (`get_route_schema`).
 *
 * Per `assistant/AGENTS.md`, IPC-only methods are registered here rather
 * than flagged inside `ROUTES`.
 */

import {
  handleRedeemTokenInvite,
  handleRedeemVoiceInvite,
} from "../../runtime/routes/contact-routes.js";
import type { RouteHandlerArgs } from "../../runtime/routes/types.js";

/**
 * IPC-only invite methods, keyed by IPC operationId. Registered directly on
 * the assistant IPC server (see `assistant-server.ts`).
 *
 * `invites_redeem_voice` / `invites_redeem_token` reuse the same split
 * handlers that back the shared HTTP `invites_redeem` route, so token/voice
 * redemption behaves identically across both transports.
 */
export const INVITE_IPC_METHODS: Record<
  string,
  (args: RouteHandlerArgs) => unknown
> = {
  invites_redeem_voice: handleRedeemVoiceInvite,
  invites_redeem_token: handleRedeemTokenInvite,
};
