import { GetContactIpcResponseSchema } from "@vellumai/gateway-client/gateway-ipc-contracts";

import { ipcCallPersistent } from "../ipc/gateway-client.js";
import type { ContactChannel } from "./types.js";

/**
 * Read a contact channel's verified state from the gateway contact-channel read
 * (ACL source of truth). Covers all contacts, not just guardian deliveries.
 * Returns `undefined` when the gateway is unreachable or has no such channel.
 */
export async function gatewayContactChannelState(
  channel: Pick<ContactChannel, "id" | "contactId">,
): Promise<{ status: string; verifiedAt: number | null } | undefined> {
  const result = await ipcCallPersistent("contacts_get_rich", {
    contactId: channel.contactId,
  });
  if (!result || (result as { contact?: unknown }).contact == null) {
    return undefined;
  }
  const { contact } = GetContactIpcResponseSchema.parse(result);
  const ch = contact.channels.find((c) => c.id === channel.id);
  return ch ? { status: ch.status, verifiedAt: ch.verifiedAt } : undefined;
}
