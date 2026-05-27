import { client } from "@/generated/api/client.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/lib/api-errors";
import type { A2AInviteParams } from "@/domains/contacts/a2a-invite";
import type {
  ChannelInfo,
  ChannelReadinessSnapshot,
  ContactPayload,
  CreateA2AInviteResponse,
  CreateContactInput,
  RedeemA2AInviteResponse,
  SlackChannelConfig,
  TelegramConfig,
  TwilioConfig,
  TwilioPhoneNumber,
} from "@/domains/contacts/types";

// These endpoints live on the per-assistant runtime daemon, proxied via
// /v1/assistants/{assistant_id}/<path>/. They are not in the generated
// OpenAPI schema — we call them through the HeyAPI client so any
// configured interceptors (CSRF, org header) still apply.

interface ListContactsResponse {
  ok?: boolean;
  contacts?: ContactPayload[];
}

interface SingleContactResponse {
  ok?: boolean;
  contact?: ContactPayload;
}

interface ChannelReadinessResponse {
  success?: boolean;
  snapshots?: ChannelReadinessSnapshot[];
}

interface ChannelAvailabilityResponse {
  channels?: ChannelInfo[];
}

export async function listContacts(
  assistantId: string,
  opts: { limit?: number; role?: string } = {},
): Promise<ContactPayload[]> {
  const query: Record<string, string | number> = { limit: opts.limit ?? 50 };
  if (opts.role) query.role = opts.role;

  const { data, error, response } = await client.get<
    ListContactsResponse,
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/contacts/",
    path: { assistant_id: assistantId },
    query,
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to list contacts");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to list contacts"),
    );
  }
  return data?.contacts ?? [];
}

export async function createContact(
  assistantId: string,
  input: CreateContactInput,
): Promise<ContactPayload> {
  const { data, error, response } = await client.post<
    SingleContactResponse,
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/contacts/",
    path: { assistant_id: assistantId },
    body: input,
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to create contact");
  if (!response.ok || !data?.contact) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to create contact"),
    );
  }
  return data.contact;
}

export async function deleteContact(
  assistantId: string,
  contactId: string,
): Promise<void> {
  const { error, response } = await client.delete<unknown, unknown>({
    url: "/v1/assistants/{assistant_id}/contacts/{contact_id}/",
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

export async function updateContact(
  assistantId: string,
  contactId: string,
  patch: { displayName: string; notes?: string | null },
): Promise<ContactPayload> {
  // The runtime's /contacts endpoint upserts: POST with `id` in the body
  // updates the existing contact. There is no PATCH /contacts/{id}.
  const body: Record<string, unknown> = {
    id: contactId,
    displayName: patch.displayName,
  };
  if (patch.notes !== undefined) body.notes = patch.notes;

  const { data, error, response } = await client.post<
    SingleContactResponse,
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/contacts/",
    path: { assistant_id: assistantId },
    body,
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to update contact");
  if (!response.ok || !data?.contact) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to update contact"),
    );
  }
  return data.contact;
}

/**
 * Hardcoded fallback for assistants that don't expose
 * `/v1/channels/available` yet. The web client isn't versioned alongside
 * the assistant runtime, so we need to render something sensible against
 * an older gateway.
 *
 * TODO: delete once assistant 0.8.1 is EOL — then the gateway is
 * guaranteed to serve `/v1/channels/available` and the empty-array
 * fallback in the caller is sufficient.
 */
const DEFAULT_CHANNELS: ChannelInfo[] = [
  {
    id: "slack",
    label: "Slack",
    subtitle: "Message your assistant from Slack",
    icon: "hash",
    supportsVerification: true,
    setupMessages: {
      guardian:
        "I'd like to verify my identity as your guardian on Slack. Can you help me set that up?",
      contact:
        "I'd like to verify a contact's Slack identity. Can you walk me through it?",
    },
  },
  {
    id: "telegram",
    label: "Telegram",
    subtitle: "Message your assistant from Telegram",
    icon: "send",
    supportsVerification: true,
    setupMessages: {
      guardian:
        "I'd like to verify my identity as your guardian on Telegram. Can you help me set that up?",
      contact:
        "I'd like to verify a contact's Telegram identity. Can you walk me through it?",
    },
  },
  {
    id: "phone",
    label: "Phone Calling",
    subtitle: "Call or text your assistant via phone",
    icon: "phone",
    supportsVerification: true,
    setupMessages: {
      guardian:
        "I'd like to verify my identity as your guardian for phone calls. Can you help me set that up?",
      contact:
        "I'd like to verify a contact's phone number. Can you help me set that up?",
    },
  },
];

export async function fetchChannelAvailability(
  assistantId: string,
): Promise<ChannelInfo[]> {
  const { data, error, response } = await client.get<
    ChannelAvailabilityResponse,
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/channels/available/",
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to fetch channel availability");
  if (response.status === 404) {
    return DEFAULT_CHANNELS;
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(
        error,
        response,
        "Failed to fetch channel availability",
      ),
    );
  }
  return data?.channels ?? [];
}

export async function fetchChannelReadiness(
  assistantId: string,
): Promise<ChannelReadinessSnapshot[]> {
  const { data, error, response } = await client.get<
    ChannelReadinessResponse,
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/channels/readiness/",
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to fetch channel readiness");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to fetch channel readiness"),
    );
  }
  return data?.snapshots ?? [];
}

export async function fetchSlackChannelConfig(
  assistantId: string,
): Promise<SlackChannelConfig> {
  const { data, error, response } = await client.get<
    SlackChannelConfig,
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/integrations/slack/channel/config/",
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to fetch Slack config");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to fetch Slack config"),
    );
  }
  return data ?? {};
}

export async function deleteSlackChannelConfig(
  assistantId: string,
): Promise<void> {
  const { error, response } = await client.delete<unknown, unknown>({
    url: "/v1/assistants/{assistant_id}/integrations/slack/channel/config/",
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to disconnect Slack");
  if (!response.ok && response.status !== 204) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to disconnect Slack"),
    );
  }
}

export async function setSlackChannelConfig(
  assistantId: string,
  botToken: string,
  appToken: string,
): Promise<void> {
  const { error, response } = await client.post<unknown, unknown>({
    url: "/v1/assistants/{assistant_id}/integrations/slack/channel/config/",
    path: { assistant_id: assistantId },
    body: { botToken, appToken },
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to save Slack config");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to save Slack config"),
    );
  }
}

export async function fetchTelegramConfig(
  assistantId: string,
): Promise<TelegramConfig> {
  const { data, error, response } = await client.get<TelegramConfig, unknown>({
    url: "/v1/assistants/{assistant_id}/integrations/telegram/config/",
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to fetch Telegram config");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to fetch Telegram config"),
    );
  }
  return data ?? { success: false, hasBotToken: false, connected: false };
}

export async function setTelegramConfig(
  assistantId: string,
  botToken: string,
): Promise<void> {
  const { error, response } = await client.post<unknown, unknown>({
    url: "/v1/assistants/{assistant_id}/integrations/telegram/config/",
    path: { assistant_id: assistantId },
    body: { botToken },
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to save Telegram config");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to save Telegram config"),
    );
  }
}

export async function clearTelegramConfig(
  assistantId: string,
): Promise<void> {
  const { error, response } = await client.delete<unknown, unknown>({
    url: "/v1/assistants/{assistant_id}/integrations/telegram/config/",
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to clear Telegram config");
  if (!response.ok && response.status !== 204) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to clear Telegram config"),
    );
  }
}

export async function fetchTwilioConfig(
  assistantId: string,
): Promise<TwilioConfig> {
  const { data, error, response } = await client.get<TwilioConfig, unknown>({
    url: "/v1/assistants/{assistant_id}/integrations/twilio/config/",
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to fetch Twilio config");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to fetch Twilio config"),
    );
  }
  return data ?? { success: false, hasCredentials: false };
}

export async function setTwilioCredentials(
  assistantId: string,
  accountSid: string,
  authToken: string,
): Promise<void> {
  const { error, response } = await client.post<unknown, unknown>({
    url: "/v1/assistants/{assistant_id}/integrations/twilio/credentials/",
    path: { assistant_id: assistantId },
    body: { accountSid, authToken },
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to save Twilio credentials");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to save Twilio credentials"),
    );
  }
}

export async function clearTwilioCredentials(
  assistantId: string,
): Promise<void> {
  const { error, response } = await client.delete<unknown, unknown>({
    url: "/v1/assistants/{assistant_id}/integrations/twilio/credentials/",
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to clear Twilio credentials");
  if (!response.ok && response.status !== 204) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to clear Twilio credentials"),
    );
  }
}

interface TwilioNumbersResponse {
  success: boolean;
  numbers?: TwilioPhoneNumber[];
}

export async function listTwilioNumbers(
  assistantId: string,
): Promise<TwilioPhoneNumber[]> {
  const { data, error, response } = await client.get<
    TwilioNumbersResponse,
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/integrations/twilio/numbers/",
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to list Twilio numbers");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to list Twilio numbers"),
    );
  }
  return data?.numbers ?? [];
}

export async function assignTwilioNumber(
  assistantId: string,
  phoneNumber: string,
): Promise<void> {
  const { error, response } = await client.post<unknown, unknown>({
    url: "/v1/assistants/{assistant_id}/integrations/twilio/numbers/assign/",
    path: { assistant_id: assistantId },
    body: { phoneNumber },
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to assign Twilio number");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to assign Twilio number"),
    );
  }
}

export async function mergeContacts(
  assistantId: string,
  keepId: string,
  mergeId: string,
): Promise<ContactPayload> {
  const { data, error, response } = await client.post<
    SingleContactResponse,
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/contacts/merge/",
    path: { assistant_id: assistantId },
    body: { keepId, mergeId },
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to merge contacts");
  if (!response.ok || !data?.contact) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to merge contacts"),
    );
  }
  return data.contact;
}

interface DaemonCreateInviteResponse {
  inviteId?: string;
  token?: string;
  expiresAt?: number;
  success?: boolean;
}

export async function createA2AInvite(
  assistantId: string,
  opts?: { expiresInHours?: number },
): Promise<CreateA2AInviteResponse> {
  const body: Record<string, unknown> = {};
  if (opts?.expiresInHours !== undefined) {
    body.expiresInHours = opts.expiresInHours;
  }

  const { data, error, response } = await client.post<
    DaemonCreateInviteResponse,
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/integrations/a2a/invite/",
    path: { assistant_id: assistantId },
    body,
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to create A2A invite");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to create A2A invite"),
    );
  }
  if (!data?.inviteId || !data.token || data.expiresAt === undefined) {
    throw new ApiError(
      500,
      "Create invite succeeded but response is missing required fields",
    );
  }

  return {
    inviteId: data.inviteId,
    token: data.token,
    expiresAt: data.expiresAt,
  };
}

interface DjangoRedeemInviteResponse {
  success?: boolean;
  already_connected?: boolean;
  error?: string;
  error_code?: string;
}

export async function redeemA2AInvite(
  receiverAssistantId: string,
  input: A2AInviteParams,
): Promise<RedeemA2AInviteResponse> {
  const { data, error, response } = await client.post<
    DjangoRedeemInviteResponse,
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

export async function verifyContactChannel(
  assistantId: string,
  channelId: string,
): Promise<void> {
  const { error, response } = await client.post<unknown, unknown>({
    url: "/v1/assistants/{assistant_id}/contact-channels/{channel_id}/verify/",
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

export async function revokeContactChannel(
  assistantId: string,
  channelId: string,
): Promise<void> {
  const { error, response } = await client.patch<unknown, unknown>({
    url: "/v1/assistants/{assistant_id}/contact-channels/{channel_id}/",
    path: { assistant_id: assistantId, channel_id: channelId },
    body: { status: "revoked" },
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to revoke channel");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to revoke channel"),
    );
  }
}
