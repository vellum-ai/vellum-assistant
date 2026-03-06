/**
 * Route handlers for contact management endpoints.
 *
 * GET    /v1/contacts              — list contacts
 * POST   /v1/contacts              — create or update a contact
 * GET    /v1/contacts/:id          — get a contact by ID
 * DELETE /v1/contacts/:id          — delete a contact
 * POST   /v1/contacts/merge        — merge two contacts
 * PATCH  /v1/contact-channels/:contactChannelId — update a contact channel's status/policy
 * POST   /v1/contact-channels/:contactChannelId/verify — initiate trusted contact verification
 */

import { createHash, randomBytes } from "node:crypto";

import type { ChannelId } from "../../channels/types.js";
import { resolveGuardianName } from "../../config/user-reference.js";
import {
  deleteContact,
  getAssistantContactMetadata,
  getChannelById,
  getContact,
  listContacts,
  mergeContacts,
  searchContacts,
  updateChannelStatus,
  upsertAssistantContactMetadata,
  upsertContact,
  validateSpeciesMetadata,
} from "../../contacts/contact-store.js";
import type {
  AssistantSpecies,
  ChannelPolicy,
  ChannelStatus,
  ContactRole,
  ContactType,
} from "../../contacts/types.js";
import { getCredentialMetadata } from "../../tools/credentials/metadata-store.js";
import { normalizePhoneNumber } from "../../util/phone.js";
import {
  countRecentSendsToDestination,
  createOutboundSession,
  updateSessionDelivery,
} from "../channel-guardian-service.js";
import {
  deliverVerificationSlack,
  deliverVerificationSms,
  deliverVerificationTelegram,
  DESTINATION_RATE_WINDOW_MS,
  MAX_SENDS_PER_DESTINATION_WINDOW,
  normalizeTelegramDestination,
} from "../guardian-outbound-actions.js";
import {
  composeVerificationSlack,
  composeVerificationSms,
  composeVerificationTelegram,
  GUARDIAN_VERIFY_TEMPLATE_KEYS,
} from "../guardian-verification-templates.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

function withGuardianNameOverride<
  T extends { role: string; displayName: string },
>(contact: T): T {
  if (contact.role === "guardian") {
    return {
      ...contact,
      displayName: resolveGuardianName(contact.displayName),
    };
  }
  return contact;
}

const VALID_CONTACT_TYPES: readonly ContactType[] = ["human", "assistant"];
const VALID_ASSISTANT_SPECIES: readonly AssistantSpecies[] = [
  "vellum",
  "openclaw",
];

/**
 * GET /v1/contacts?limit=50&role=guardian&contactType=human
 *
 * Also supports search query params: query, channelAddress, channelType.
 * When any search param is provided, delegates to searchContacts() instead of listContacts().
 */
export function handleListContacts(url: URL): Response {
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const role = url.searchParams.get("role") as ContactRole | null;
  const contactTypeParam = url.searchParams.get("contactType");
  const query = url.searchParams.get("query");
  const channelAddress = url.searchParams.get("channelAddress");
  const channelType = url.searchParams.get("channelType");
  if (contactTypeParam && !isContactType(contactTypeParam)) {
    return httpError(
      "BAD_REQUEST",
      `Invalid contactType "${contactTypeParam}". Must be one of: ${VALID_CONTACT_TYPES.join(", ")}`,
      400,
    );
  }

  const hasSearchParams = query || channelAddress || channelType;

  const contactType = contactTypeParam
    ? (contactTypeParam as ContactType)
    : undefined;

  if (hasSearchParams) {
    const contacts = searchContacts({
      query: query ?? undefined,
      channelAddress: channelAddress ?? undefined,
      channelType: channelType ?? undefined,
      role: role ?? undefined,
      contactType,
      limit,
    });
    return Response.json({
      ok: true,
      contacts: contacts.map(withGuardianNameOverride),
    });
  }

  const contacts = listContacts(limit, role ?? undefined, contactType);
  return Response.json({
    ok: true,
    contacts: contacts.map(withGuardianNameOverride),
  });
}

/**
 * GET /v1/contacts/:id
 */
export function handleGetContact(contactId: string): Response {
  const contact = getContact(contactId);
  if (!contact) {
    return httpError("NOT_FOUND", `Contact "${contactId}" not found`, 404);
  }
  const assistantMeta =
    contact.contactType === "assistant"
      ? getAssistantContactMetadata(contact.id)
      : undefined;
  return Response.json({
    ok: true,
    contact: withGuardianNameOverride(contact),
    assistantMetadata: assistantMeta ?? undefined,
  });
}

/**
 * DELETE /v1/contacts/:id
 */
export function handleDeleteContact(contactId: string): Response {
  const result = deleteContact(contactId);
  if (result === "not_found") {
    return httpError("NOT_FOUND", `Contact "${contactId}" not found`, 404);
  }
  if (result === "is_guardian") {
    return httpError("FORBIDDEN", "Cannot delete a guardian contact", 403);
  }
  return new Response(null, { status: 204 });
}

/**
 * POST /v1/contacts/merge { keepId, mergeId }
 */
export async function handleMergeContacts(req: Request): Promise<Response> {
  const body = (await req.json()) as { keepId?: string; mergeId?: string };

  if (!body.keepId || !body.mergeId) {
    return httpError("BAD_REQUEST", "keepId and mergeId are required", 400);
  }

  try {
    const contact = mergeContacts(body.keepId, body.mergeId);
    return Response.json({
      ok: true,
      contact: withGuardianNameOverride(contact),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return httpError("BAD_REQUEST", message, 400);
  }
}

const VALID_CHANNEL_STATUSES: readonly ChannelStatus[] = [
  "active",
  "pending",
  "revoked",
  "blocked",
  "unverified",
];
const VALID_CHANNEL_POLICIES: readonly ChannelPolicy[] = [
  "allow",
  "deny",
  "escalate",
];

function isContactType(value: string): value is ContactType {
  return (VALID_CONTACT_TYPES as readonly string[]).includes(value);
}

function isAssistantSpecies(value: string): value is AssistantSpecies {
  return (VALID_ASSISTANT_SPECIES as readonly string[]).includes(value);
}

function isChannelStatus(value: string): value is ChannelStatus {
  return (VALID_CHANNEL_STATUSES as readonly string[]).includes(value);
}

function isChannelPolicy(value: string): value is ChannelPolicy {
  return (VALID_CHANNEL_POLICIES as readonly string[]).includes(value);
}

/**
 * POST /v1/contacts { displayName, id?, notes?, contactType?, assistantMetadata?, ... }
 */
export async function handleUpsertContact(req: Request): Promise<Response> {
  const body = (await req.json()) as {
    id?: string;
    displayName?: string;
    notes?: string;
    role?: string;
    contactType?: string;
    assistantMetadata?: {
      species: string;
      metadata?: Record<string, unknown>;
    };
    channels?: Array<{
      type: string;
      address: string;
      isPrimary?: boolean;
      status?: string;
      policy?: string;
      externalUserId?: string;
      externalChatId?: string;
    }>;
  };

  if (
    !body.displayName ||
    typeof body.displayName !== "string" ||
    body.displayName.trim().length === 0
  ) {
    return httpError(
      "BAD_REQUEST",
      "displayName is required and must be a non-empty string",
      400,
    );
  }

  if (body.contactType !== undefined && !isContactType(body.contactType)) {
    return httpError(
      "BAD_REQUEST",
      `Invalid contactType "${body.contactType}". Must be one of: ${VALID_CONTACT_TYPES.join(", ")}`,
      400,
    );
  }

  if (body.contactType === "assistant") {
    if (!body.assistantMetadata) {
      return httpError(
        "BAD_REQUEST",
        'assistantMetadata is required when contactType is "assistant"',
        400,
      );
    }
    if (!isAssistantSpecies(body.assistantMetadata.species)) {
      return httpError(
        "BAD_REQUEST",
        `Invalid species "${body.assistantMetadata.species}". Must be one of: ${VALID_ASSISTANT_SPECIES.join(", ")}`,
        400,
      );
    }
    try {
      validateSpeciesMetadata(
        body.assistantMetadata.species as AssistantSpecies,
        body.assistantMetadata.metadata ?? null,
      );
    } catch (err) {
      return httpError(
        "BAD_REQUEST",
        err instanceof Error ? err.message : String(err),
        400,
      );
    }
  }

  if (body.contactType === "human" && body.assistantMetadata) {
    return httpError(
      "BAD_REQUEST",
      'assistantMetadata must not be provided when contactType is "human"',
      400,
    );
  }

  if (body.assistantMetadata && !body.contactType) {
    return httpError(
      "BAD_REQUEST",
      'contactType must be "assistant" when assistantMetadata is provided',
      400,
    );
  }

  if (body.channels) {
    if (!Array.isArray(body.channels)) {
      return httpError("BAD_REQUEST", "channels must be an array", 400);
    }
    for (const ch of body.channels) {
      if (ch.status !== undefined && !isChannelStatus(ch.status)) {
        return httpError(
          "BAD_REQUEST",
          `Invalid channel status "${ch.status}". Must be one of: ${VALID_CHANNEL_STATUSES.join(", ")}`,
          400,
        );
      }
      if (ch.policy !== undefined && !isChannelPolicy(ch.policy)) {
        return httpError(
          "BAD_REQUEST",
          `Invalid channel policy "${ch.policy}". Must be one of: ${VALID_CHANNEL_POLICIES.join(", ")}`,
          400,
        );
      }
    }
  }

  try {
    const contact = upsertContact({
      id: body.id,
      displayName: body.displayName.trim(),
      notes: body.notes,
      role: body.role as ContactRole | undefined,
      contactType: body.contactType as ContactType | undefined,
      channels: body.channels?.map((ch) => ({
        ...ch,
        status: ch.status as ChannelStatus | undefined,
        policy: ch.policy as ChannelPolicy | undefined,
      })),
    });

    if (body.assistantMetadata) {
      upsertAssistantContactMetadata({
        contactId: contact.id,
        species: body.assistantMetadata.species as AssistantSpecies,
        metadata: body.assistantMetadata.metadata ?? null,
      });
    }

    return Response.json(
      { ok: true, contact: withGuardianNameOverride(contact) },
      { status: contact.created ? 201 : 200 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return httpError("BAD_REQUEST", message, 400);
  }
}

/**
 * PATCH /v1/contact-channels/:contactChannelId { status?, policy?, reason? }
 */
export async function handleUpdateContactChannel(
  req: Request,
  channelId: string,
): Promise<Response> {
  const body = (await req.json()) as {
    status?: string;
    policy?: string;
    reason?: string;
  };

  if (body.status !== undefined && !isChannelStatus(body.status)) {
    return httpError(
      "BAD_REQUEST",
      `Invalid status "${
        body.status
      }". Must be one of: ${VALID_CHANNEL_STATUSES.join(", ")}`,
      400,
    );
  }

  if (body.policy !== undefined && !isChannelPolicy(body.policy)) {
    return httpError(
      "BAD_REQUEST",
      `Invalid policy "${
        body.policy
      }". Must be one of: ${VALID_CHANNEL_POLICIES.join(", ")}`,
      400,
    );
  }

  // Blocked-state guard: revoking a blocked channel is not allowed because
  // blocking is a stronger action than revoking. The caller must explicitly
  // unblock (set status to "active") before revoking.
  if (body.status === "revoked") {
    const existing = getChannelById(channelId);
    if (!existing) {
      return httpError("NOT_FOUND", `Channel "${channelId}" not found`, 404);
    }
    if (existing.status === "blocked") {
      return httpError(
        "CONFLICT",
        "Cannot revoke a blocked channel. Unblock it first or leave it blocked.",
        409,
      );
    }
  }

  const updated = updateChannelStatus(channelId, {
    status: body.status,
    policy: body.policy,
    revokedReason:
      body.status !== undefined
        ? body.status === "revoked"
          ? (body.reason ?? null)
          : null
        : undefined,
    blockedReason:
      body.status !== undefined
        ? body.status === "blocked"
          ? (body.reason ?? null)
          : null
        : undefined,
  });

  if (!updated) {
    return httpError("NOT_FOUND", `Channel "${channelId}" not found`, 404);
  }

  const parentContact = getContact(updated.contactId);
  return Response.json({
    ok: true,
    contact: parentContact
      ? withGuardianNameOverride(parentContact)
      : undefined,
  });
}

// ---------------------------------------------------------------------------
// Channel verification
// ---------------------------------------------------------------------------

/** Session TTL in seconds (matches challenge TTL of 10 minutes). */
const SESSION_TTL_SECONDS = 600;

/**
 * Map a contact channel type to the verification ChannelId used by the
 * guardian service. Returns null for unsupported channel types.
 */
function toVerificationChannel(channelType: string): ChannelId | null {
  switch (channelType) {
    case "phone":
      return "sms";
    case "telegram":
      return "telegram";
    case "slack":
      return "slack";
    default:
      return null;
  }
}

/**
 * Get the Telegram bot username from credential metadata.
 * Falls back to process.env.TELEGRAM_BOT_USERNAME.
 */
function getTelegramBotUsername(): string | undefined {
  const meta = getCredentialMetadata("telegram", "bot_token");
  if (
    meta?.accountInfo &&
    typeof meta.accountInfo === "string" &&
    meta.accountInfo.trim().length > 0
  ) {
    return meta.accountInfo.trim();
  }
  return process.env.TELEGRAM_BOT_USERNAME || undefined;
}

/**
 * POST /v1/contact-channels/:contactChannelId/verify
 *
 * Initiate trusted contact verification for a specific channel. Sends a
 * verification code via SMS, Telegram, Slack, or voice and returns session
 * info so the client can track the verification flow.
 */
export async function handleVerifyContactChannel(
  contactChannelId: string,
  assistantId: string,
): Promise<Response> {
  const channel = getChannelById(contactChannelId);
  if (!channel) {
    return httpError(
      "NOT_FOUND",
      `Channel "${contactChannelId}" not found`,
      404,
    );
  }

  const contact = getContact(channel.contactId);
  if (!contact) {
    return httpError(
      "NOT_FOUND",
      `Contact "${channel.contactId}" not found`,
      404,
    );
  }

  // Already verified — no need to re-verify
  if (channel.status === "active" && channel.verifiedAt != null) {
    return httpError("CONFLICT", "Channel is already verified", 409);
  }

  const verificationChannel = toVerificationChannel(channel.type);
  if (!verificationChannel) {
    return httpError(
      "BAD_REQUEST",
      `Verification is not supported for channel type "${channel.type}"`,
      400,
    );
  }

  const destination = channel.address;
  if (!destination) {
    return httpError(
      "BAD_REQUEST",
      "Channel has no address to send verification to",
      400,
    );
  }

  // Normalize Telegram destinations so rate-limit lookups are consistent with
  // guardian-outbound-actions (strips leading '@', lowercases handles).
  const effectiveDestination =
    verificationChannel === "telegram"
      ? normalizeTelegramDestination(destination)
      : destination;

  // Rate limit check
  const recentSendCount = countRecentSendsToDestination(
    verificationChannel,
    effectiveDestination,
    DESTINATION_RATE_WINDOW_MS,
  );
  if (recentSendCount >= MAX_SENDS_PER_DESTINATION_WINDOW) {
    return httpError(
      "RATE_LIMITED",
      "Too many verification attempts to this destination. Please try again later.",
      429,
    );
  }

  // --- SMS verification ---
  if (verificationChannel === "sms") {
    const phoneE164 = normalizePhoneNumber(destination);
    if (!phoneE164) {
      return httpError(
        "BAD_REQUEST",
        "Channel address is not a valid phone number",
        400,
      );
    }

    const sessionResult = createOutboundSession({
      channel: verificationChannel,
      expectedPhoneE164: phoneE164,
      expectedExternalUserId: channel.externalUserId ?? undefined,
      destinationAddress: phoneE164,
      verificationPurpose: "trusted_contact",
    });

    const smsBody = composeVerificationSms(
      GUARDIAN_VERIFY_TEMPLATE_KEYS.CHALLENGE_REQUEST,
      {
        code: sessionResult.secret,
        expiresInMinutes: Math.floor(SESSION_TTL_SECONDS / 60),
      },
    );

    const now = Date.now();
    const sendCount = 1;
    updateSessionDelivery(sessionResult.sessionId, now, sendCount, null);
    deliverVerificationSms(phoneE164, smsBody, assistantId);

    return Response.json({
      ok: true,
      verificationSessionId: sessionResult.sessionId,
      expiresAt: sessionResult.expiresAt,
      sendCount,
    });
  }

  // --- Telegram verification ---
  if (verificationChannel === "telegram") {
    // Telegram with known chat ID: identity is already bound
    if (channel.externalChatId) {
      const sessionResult = createOutboundSession({
        channel: verificationChannel,
        expectedChatId: channel.externalChatId,
        expectedExternalUserId: channel.externalUserId ?? undefined,
        identityBindingStatus: "bound",
        destinationAddress: effectiveDestination,
        verificationPurpose: "trusted_contact",
      });

      const telegramBody = composeVerificationTelegram(
        GUARDIAN_VERIFY_TEMPLATE_KEYS.TELEGRAM_CHALLENGE_REQUEST,
        {
          code: sessionResult.secret,
          expiresInMinutes: Math.floor(SESSION_TTL_SECONDS / 60),
        },
      );

      const now = Date.now();
      const sendCount = 1;
      updateSessionDelivery(sessionResult.sessionId, now, sendCount, null);
      deliverVerificationTelegram(
        channel.externalChatId,
        telegramBody,
        assistantId,
      );

      return Response.json({
        ok: true,
        verificationSessionId: sessionResult.sessionId,
        expiresAt: sessionResult.expiresAt,
        sendCount,
      });
    }

    // Telegram handle only (no chat ID): bootstrap flow
    const { ensureTelegramBotUsernameResolved } =
      await import("../channel-invite-transports/telegram.js");
    await ensureTelegramBotUsernameResolved();
    const botUsername = getTelegramBotUsername();
    if (!botUsername) {
      return httpError(
        "BAD_REQUEST",
        "Telegram bot username is not configured. Set up the Telegram integration first.",
        400,
      );
    }

    const bootstrapToken = randomBytes(16).toString("hex");
    const bootstrapTokenHash = createHash("sha256")
      .update(bootstrapToken)
      .digest("hex");

    const sessionResult = createOutboundSession({
      channel: verificationChannel,
      identityBindingStatus: "pending_bootstrap",
      destinationAddress: effectiveDestination,
      bootstrapTokenHash,
      verificationPurpose: "trusted_contact",
    });

    const telegramBootstrapUrl = `https://t.me/${botUsername}?start=gv_${bootstrapToken}`;

    return Response.json({
      ok: true,
      verificationSessionId: sessionResult.sessionId,
      expiresAt: sessionResult.expiresAt,
      sendCount: 0,
      telegramBootstrapUrl,
    });
  }

  // --- Slack verification ---
  if (verificationChannel === "slack") {
    const slackUserId = channel.externalUserId ?? destination;

    // Only claim identity is bound when we have at least one platform identifier
    const hasIdentityBinding = Boolean(
      channel.externalUserId || channel.externalChatId,
    );
    if (!hasIdentityBinding) {
      return httpError(
        "BAD_REQUEST",
        "Slack verification requires an externalUserId or externalChatId for identity binding",
        400,
      );
    }

    const sessionResult = createOutboundSession({
      channel: verificationChannel,
      expectedExternalUserId: channel.externalUserId ?? undefined,
      expectedChatId: channel.externalChatId ?? undefined,
      identityBindingStatus: "bound",
      destinationAddress: slackUserId,
      verificationPurpose: "trusted_contact",
    });

    const slackBody = composeVerificationSlack(
      GUARDIAN_VERIFY_TEMPLATE_KEYS.SLACK_CHALLENGE_REQUEST,
      {
        code: sessionResult.secret,
        expiresInMinutes: Math.floor(SESSION_TTL_SECONDS / 60),
      },
    );

    const now = Date.now();
    const sendCount = 1;
    updateSessionDelivery(sessionResult.sessionId, now, sendCount, null);
    deliverVerificationSlack(slackUserId, slackBody, assistantId);

    return Response.json({
      ok: true,
      verificationSessionId: sessionResult.sessionId,
      expiresAt: sessionResult.expiresAt,
      sendCount,
    });
  }

  return httpError(
    "BAD_REQUEST",
    `Verification is not supported for channel type "${channel.type}"`,
    400,
  );
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function contactRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "contacts",
      method: "GET",
      handler: ({ url }) => handleListContacts(url),
    },
    {
      endpoint: "contacts",
      method: "POST",
      handler: async ({ req }) => handleUpsertContact(req),
    },
    {
      endpoint: "contacts/merge",
      method: "POST",
      handler: async ({ req }) => handleMergeContacts(req),
    },
    {
      endpoint: "contact-channels/:contactChannelId",
      method: "PATCH",
      policyKey: "contact-channels",
      handler: async ({ req, params }) =>
        handleUpdateContactChannel(req, params.contactChannelId),
    },
    {
      endpoint: "contact-channels/:contactChannelId/verify",
      method: "POST",
      policyKey: "contact-channels",
      handler: async ({ params, authContext }) =>
        handleVerifyContactChannel(
          params.contactChannelId,
          authContext.assistantId,
        ),
    },
  ];
}

/**
 * Catch-all `contacts/:id` route. Must be registered AFTER any routes that
 * share the `contacts/` prefix (e.g. `inviteRouteDefinitions()`) to avoid
 * the `:id` parameter matching literal sub-paths like "invites".
 */
export function contactCatchAllRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "contacts/:id",
      method: "GET",
      policyKey: "contacts",
      handler: ({ params }) => handleGetContact(params.id),
    },
    {
      endpoint: "contacts/:id",
      method: "DELETE",
      policyKey: "contacts",
      handler: ({ params }) => handleDeleteContact(params.id),
    },
  ];
}
