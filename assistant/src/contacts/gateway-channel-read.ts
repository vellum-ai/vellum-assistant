import { GetContactIpcResponseSchema } from "@vellumai/gateway-client/gateway-ipc-contracts";

import { ipcCallPersistent } from "../ipc/gateway-client.js";
import { getLogger } from "../util/logger.js";
import type { ContactChannel } from "./types.js";

const log = getLogger("gateway-channel-read");

/**
 * Read a contact channel's verified state from the gateway contact-channel read
 * (ACL source of truth). Covers all contacts, not just guardian deliveries.
 *
 * Matches the gateway row by logical identity — `(type, address)`,
 * case-insensitive — not by id, so a reconcile-divergent row that the gateway
 * write helpers re-keyed under a different UUID is still found.
 *
 * Returns `undefined` for unreachable reads (gateway down, IPC timeout, schema
 * mismatch) or when no such channel exists, so callers fail open.
 */
export async function gatewayContactChannelState(
  channel: Pick<ContactChannel, "contactId" | "type" | "address">,
): Promise<{ status: string; verifiedAt: number | null } | undefined> {
  let result: unknown;
  try {
    result = await ipcCallPersistent("contacts_get_rich", {
      contactId: channel.contactId,
    });
  } catch (err) {
    log.warn(
      { err, contactId: channel.contactId },
      "contacts_get_rich unreachable — failing open",
    );
    return undefined;
  }
  if (!result || (result as { contact?: unknown }).contact == null) {
    return undefined;
  }
  const parsed = GetContactIpcResponseSchema.safeParse(result);
  if (!parsed.success) {
    log.warn(
      { err: parsed.error, contactId: channel.contactId },
      "contacts_get_rich response failed schema parse — failing open",
    );
    return undefined;
  }
  const address = channel.address.toLowerCase();
  const ch = parsed.data.contact.channels.find(
    (c) => c.type === channel.type && c.address.toLowerCase() === address,
  );
  return ch ? { status: ch.status, verifiedAt: ch.verifiedAt } : undefined;
}
