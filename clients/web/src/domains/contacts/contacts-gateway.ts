/**
 * Gateway-native contact operations.
 *
 * These endpoints are handled directly by the gateway control plane
 * (contacts-control-plane-proxy.ts), not the daemon, so they live in the
 * generated gateway SDK rather than the daemon SDK. The gateway client's
 * interceptor forwards them to the self-hosted gateway in local /
 * self-hosted mode and falls through to the platform proxy for
 * platform-hosted assistants.
 */

import { client } from "@/generated/api/client.gen";
import {
  assistantContactDelete,
  assistantContactsUpsert,
  assistantContactChannelVerify,
} from "@/generated/gateway/sdk.gen";
import type { AssistantContactsUpsertData } from "@/generated/gateway/types.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";
import type { ContactsGetResponse } from "@/generated/daemon/types.gen";

type Contact = ContactsGetResponse["contacts"][number];

export async function upsertContact(
  assistantId: string,
  body: AssistantContactsUpsertData["body"],
): Promise<Contact> {
  const { data, error, response } = await assistantContactsUpsert({
    path: { assistant_id: assistantId },
    body,
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to save contact");
  if (!response.ok || !data?.contact) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to save contact"),
    );
  }
  // The gateway's ContactPayload matches the daemon contact wire shape the
  // contacts list is typed with (see toContactPayload in the gateway).
  return data.contact as Contact;
}

export async function deleteContact(
  assistantId: string,
  contactId: string,
): Promise<void> {
  const { error, response } = await assistantContactDelete({
    path: { assistant_id: assistantId, contact_id: contactId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to delete contact");
  if (!response.ok && response.status !== 204) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to delete contact"),
    );
  }
}

export async function verifyContactChannel(
  assistantId: string,
  channelId: string,
): Promise<void> {
  const { error, response } = await assistantContactChannelVerify({
    path: { assistant_id: assistantId, channel_id: channelId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to verify channel");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to verify channel"),
    );
  }
}

/**
 * Link an existing channel account to a contact: attach the provider account
 * ID as a contact channel via the gateway upsert, then mark it verified
 * (`verifiedVia: "manual"` — the guardian vouches for the identity, no
 * handshake needed). Channel-agnostic: the gateway DB owns contact channels
 * and ACL for every adapter.
 *
 * The gateway upsert silently skips a channel whose (type, address) already
 * belongs to another contact, so a missing channel on the returned contact
 * is surfaced as a conflict error instead of a half-linked success.
 */
export async function linkContactChannelAccount(
  assistantId: string,
  contact: { id: string; displayName: string },
  channel: { type: string; address: string },
): Promise<Contact> {
  const updated = await upsertContact(assistantId, {
    id: contact.id,
    displayName: contact.displayName,
    channels: [{ type: channel.type, address: channel.address }],
  });
  // A revoked row on this contact still matches — verifying it below re-links
  // the previously revoked account, which is the guardian's explicit intent.
  const linked = updated.channels.find(
    (ch) =>
      ch.type === channel.type &&
      ch.address.toLowerCase() === channel.address.toLowerCase(),
  );
  if (!linked) {
    throw new ApiError(
      409,
      "That account is already linked to another contact.",
    );
  }
  if (linked.status === "blocked") {
    throw new ApiError(
      409,
      "That account is blocked for this contact. Unblock it before linking.",
    );
  }
  await verifyContactChannel(assistantId, linked.id);
  return updated;
}

/**
 * Redeem an A2A invite through the platform broker (Django endpoint).
 * This is a platform-only operation — not proxied through the daemon.
 */
export async function redeemA2AInvite(
  receiverAssistantId: string,
  input: { senderAssistantId: string; token: string },
): Promise<{
  success: boolean;
  alreadyConnected?: boolean;
  error?: string;
  errorCode?: string;
}> {
  const { data, error, response } = await client.post<
    { 200: { success?: boolean; already_connected?: boolean; error?: string; error_code?: string } },
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/a2a/invites/redeem/",
    path: { assistant_id: receiverAssistantId },
    body: {
      sender_assistant_id: input.senderAssistantId,
      token: input.token,
    },
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to redeem A2A invite");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to redeem A2A invite"),
    );
  }
  return {
    success: data?.success ?? true,
    alreadyConnected: data?.already_connected,
    error: data?.error,
    errorCode: data?.error_code,
  };
}
