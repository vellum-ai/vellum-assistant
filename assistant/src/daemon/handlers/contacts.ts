import * as net from "node:net";

import {
  getContact,
  listContacts,
  updateChannelStatus,
} from "../../contacts/contact-store.js";
import type { ContactWithChannels } from "../../contacts/types.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../runtime/assistant-scope.js";
import type {
  ContactChannelPayload,
  ContactPayload,
  ContactsRequest,
} from "../ipc-protocol.js";
import { defineHandlers, type HandlerContext, log } from "./shared.js";

function toChannelPayload(
  ch: ContactWithChannels["channels"][number],
): ContactChannelPayload {
  return {
    id: ch.id,
    type: ch.type,
    address: ch.address,
    isPrimary: ch.isPrimary,
    externalUserId: ch.externalUserId ?? undefined,
    status: ch.status,
    policy: ch.policy,
    verifiedAt: ch.verifiedAt ?? undefined,
    verifiedVia: ch.verifiedVia ?? undefined,
    lastSeenAt: ch.lastSeenAt ?? undefined,
    revokedReason: ch.revokedReason ?? undefined,
    blockedReason: ch.blockedReason ?? undefined,
  };
}

function toContactPayload(contact: ContactWithChannels): ContactPayload {
  return {
    id: contact.id,
    displayName: contact.displayName,
    role: contact.role,
    relationship: contact.relationship ?? undefined,
    importance: contact.importance,
    responseExpectation: contact.responseExpectation ?? undefined,
    preferredTone: contact.preferredTone ?? undefined,
    contactType: contact.contactType ?? undefined,
    lastInteraction: contact.lastInteraction ?? undefined,
    interactionCount: contact.interactionCount,
    channels: contact.channels.map(toChannelPayload),
  };
}

export function handleContacts(
  msg: ContactsRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    switch (msg.action) {
      case "list": {
        const results = listContacts(
          DAEMON_INTERNAL_ASSISTANT_ID,
          msg.limit ?? 50,
          msg.role,
        );
        ctx.send(socket, {
          type: "contacts_response",
          success: true,
          contacts: results.map(toContactPayload),
        });
        return;
      }

      case "get": {
        if (!msg.contactId) {
          ctx.send(socket, {
            type: "contacts_response",
            success: false,
            error: "contactId is required for get",
          });
          return;
        }
        const contact = getContact(msg.contactId, DAEMON_INTERNAL_ASSISTANT_ID);
        if (!contact) {
          ctx.send(socket, {
            type: "contacts_response",
            success: false,
            error: `Contact "${msg.contactId}" not found`,
          });
          return;
        }
        ctx.send(socket, {
          type: "contacts_response",
          success: true,
          contact: toContactPayload(contact),
        });
        return;
      }

      case "update_channel": {
        if (!msg.channelId) {
          ctx.send(socket, {
            type: "contacts_response",
            success: false,
            error: "channelId is required for update_channel",
          });
          return;
        }
        const updated = updateChannelStatus(msg.channelId, {
          status: msg.status,
          policy: msg.policy,
          revokedReason:
            msg.status !== undefined
              ? msg.status === "revoked"
                ? msg.reason
                : null
              : undefined,
          blockedReason:
            msg.status !== undefined
              ? msg.status === "blocked"
                ? msg.reason
                : null
              : undefined,
        });
        if (!updated) {
          ctx.send(socket, {
            type: "contacts_response",
            success: false,
            error: `Channel "${msg.channelId}" not found`,
          });
          return;
        }
        // Return the parent contact with all channels so the client has the full picture
        const parentContact = getContact(
          updated.contactId,
          DAEMON_INTERNAL_ASSISTANT_ID,
        );
        ctx.send(socket, {
          type: "contacts_response",
          success: true,
          contact: parentContact ? toContactPayload(parentContact) : undefined,
        });
        return;
      }

      default: {
        ctx.send(socket, {
          type: "contacts_response",
          success: false,
          error: `Unknown action: ${String(msg.action)}`,
        });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "contacts handler error");
    ctx.send(socket, {
      type: "contacts_response",
      success: false,
      error: message,
    });
  }
}

export const contactsHandlers = defineHandlers({
  contacts: handleContacts,
});
