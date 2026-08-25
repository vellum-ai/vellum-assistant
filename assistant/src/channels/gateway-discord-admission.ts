/**
 * Daemon-side reader for how much Discord admits.
 *
 * The gateway owns the allow-list and the drop decision it feeds; the
 * readiness surface that reports channel setup to the user lives here. This is
 * the relay between them, and it exists for the same reason the socket-health
 * relay does: the fact lives on one side of the boundary and is reported from
 * the other.
 */

import {
  type DiscordAdmissionIpcResponse,
  DiscordAdmissionIpcResponseSchema,
} from "@vellumai/gateway-client/gateway-ipc-contracts";

import { ipcCallPersistentValidated } from "../ipc/gateway-validated-call.js";

/**
 * Ask the gateway how many channels Discord's allow-list admits.
 *
 * Throws on transport failure rather than reporting zero: an unreachable
 * gateway is a fact about the gateway, and answering zero would tell an
 * operator their allow-list is empty when nobody looked. Callers treat a throw
 * as indeterminate.
 */
export async function readDiscordAdmission(): Promise<DiscordAdmissionIpcResponse> {
  return ipcCallPersistentValidated(
    "discord_admission",
    {},
    DiscordAdmissionIpcResponseSchema,
  );
}
