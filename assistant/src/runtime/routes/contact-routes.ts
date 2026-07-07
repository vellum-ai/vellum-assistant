/**
 * Route handlers for contact and invite management endpoints.
 *
 * All routes are served by both the HTTP server and the IPC server
 * via the shared ROUTES array.
 *
 * IMPORTANT: contacts/:id routes are placed LAST in the ROUTES array so
 * they don't shadow more-specific sub-paths like contacts/invites.
 */

import {
  INVITES_IPC_METHODS,
  RedeemInviteByTokenRequestSchema,
  RedeemVoiceInviteRequestSchema,
} from "@vellumai/gateway-client";
import type { ContactRead } from "@vellumai/gateway-client/gateway-ipc-contracts";
import {
  GetContactIpcResponseSchema,
  ListContactsIpcResponseSchema,
  UpdateContactChannelIpcResponseSchema,
} from "@vellumai/gateway-client/gateway-ipc-contracts";
import { IpcCallError } from "@vellumai/gateway-client/ipc-client";
import { z } from "zod";

import {
  createInvite,
  type InviteWire,
  listInvites,
  redeemInviteByToken,
  redeemInviteByVoiceCode,
  revokeInvite,
} from "../../channels/gateway-invites.js";
import {
  listContacts,
  mergeContacts,
  searchContacts,
} from "../../contacts/contact-store.js";
import { getGuardianContactIds } from "../../contacts/guardian-contact-reader.js";
import type {
  ContactChannel,
  ContactRole,
  ContactType,
  ContactWithChannels,
} from "../../contacts/types.js";
import { ipcCallPersistent } from "../../ipc/gateway-client.js";
import { resolveGuardianName } from "../../prompts/user-reference.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS, GATEWAY_PRINCIPALS } from "../auth/route-policy.js";
import {
  composeInvitePresentation,
  resolveInviteGuardianName,
  triggerInviteCall,
} from "../invite-service.js";
import { BadRequestError, NotFoundError, RouteError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("contact-routes");

/**
 * Re-throw a relayed gateway `IpcCallError` as a `RouteError` so the IPC/HTTP
 * adapters honor its statusCode/errorCode (4xx surfaces as 4xx, not a generic
 * 500). Non-IpcCallError throws propagate unchanged.
 */
function rethrowGatewayError(err: unknown): never {
  if (err instanceof IpcCallError) {
    throw new RouteError(
      err.message,
      err.errorCode ?? "INTERNAL_ERROR",
      err.statusCode ?? 500,
      err.errorDetails,
    );
  }
  throw err;
}

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

/**
 * Stamp `role` from the gateway guardian id set on DAEMON-NATIVE reads, whose
 * local contact shape carries no role (search / contactType-filtered).
 * Fail-soft: empty set → everyone is `"contact"`.
 *
 * NOT applied to gateway-relayed reads (`contacts_list_rich`/`_get_rich`),
 * which already carry a gateway-sourced `role`. Re-deriving there would let a
 * stale/empty 30s id-set cache DOWNGRADE a freshly-rebound guardian to
 * `"contact"` during a rebind.
 */
function withGatewayRole<T extends { id: string }>(
  contact: T,
  guardianIds: ReadonlySet<string>,
): T & { role: ContactRole } {
  return {
    ...contact,
    role: guardianIds.has(contact.id) ? "guardian" : "contact",
  };
}

/** Adds `externalUserId` (= `address`) to each channel for older macOS clients. */
function withChannelCompat<T extends { channels: { address: string }[] }>(
  contact: T,
): T {
  return {
    ...contact,
    channels: contact.channels.map((ch) => ({
      ...ch,
      externalUserId: ch.address,
    })),
  };
}

interface PreparableContact {
  id: string;
  displayName: string;
  contactType?: string | null;
  channels: { address: string }[];
}

/** Compose the response transforms, then apply the guardian display-name
 * override (keyed off the role that's correct for this path) and the channel
 * compat field. Also coerces nullable gateway-sourced fields to their DB
 * defaults so the response satisfies the strict enum schema even in degraded
 * mode (assistant DB unreachable → gateway soft-fail join produces nulls).
 *
 * `guardianIds` controls where `role` comes from:
 *   - omitted (gateway-relayed reads): TRUST the gateway-sourced `role` already
 *     on the `ContactRead`. Never re-derive — a stale/empty id-set cache must
 *     not downgrade a relayed guardian to `"contact"`.
 *   - provided (daemon-native reads): the local contact shape carries no role,
 *     so derive it from the gateway guardian id set.
 */
function prepareContactResponse<T extends PreparableContact & { role: string }>(
  contact: T,
): T;
function prepareContactResponse<T extends PreparableContact>(
  contact: T,
  guardianIds: ReadonlySet<string>,
): T & { role: ContactRole };
function prepareContactResponse(
  contact: PreparableContact & { role?: string },
  guardianIds?: ReadonlySet<string>,
) {
  const coerced =
    contact.contactType == null
      ? { ...contact, contactType: "human" }
      : contact;
  const withRole = guardianIds
    ? withGatewayRole(coerced, guardianIds)
    : (coerced as PreparableContact & { role: string });
  return withChannelCompat(withGuardianNameOverride(withRole));
}

const VALID_CONTACT_TYPES: readonly ContactType[] = ["human", "assistant"];

function isContactType(value: string): value is ContactType {
  return (VALID_CONTACT_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Response schemas (drive OpenAPI spec → codegen → typed SDK)
// ---------------------------------------------------------------------------

// Channel ACL fields (status/policy/verifiedAt/verifiedVia/revokedReason/
// blockedReason) are gateway-owned and present ONLY on gateway-relayed reads
// (`contacts_list_rich`/`contacts_get_rich`). Daemon-native filtered reads
// (search / contactType) omit them, so they are `.optional()`. Contact-level
// `role` is gateway-sourced: relayed reads trust the role on the `ContactRead`,
// while daemon-native reads derive it from the gateway guardian id set at the
// serve layer (see prepareContactResponse). Interaction telemetry
// (lastSeenAt/interactionCount/lastInteraction) is gateway-owned: relayed reads
// carry it directly, and daemon-native reads batch-hydrate it from the gateway
// (see hydrateTelemetryFromGateway). On a gateway fail-soft the count
// `interactionCount` defaults to 0 (never served as null, so callers render a
// real number); the `lastSeenAt`/`lastInteraction` timestamps degrade to null.
// The timestamp fields stay `.nullable()`; `interactionCount` is kept nullable
// defensively for the relay path, but is never emitted null.
const contactChannelSchema = z.object({
  id: z.string(),
  contactId: z.string(),
  type: z.string(),
  address: z.string(),
  isPrimary: z.boolean(),
  /** @deprecated Echoes `address` for backwards compatibility with older macOS clients. */
  externalUserId: z.string().nullable(),
  status: z.string().optional(),
  policy: z.string().optional(),
  verifiedAt: z.number().nullable().optional(),
  verifiedVia: z.string().nullable().optional(),
  lastSeenAt: z.number().nullable(),
  interactionCount: z.number().nullable(),
  lastInteraction: z.number().nullable(),
  revokedReason: z.string().nullable().optional(),
  blockedReason: z.string().nullable().optional(),
});

const contactSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  role: z.enum(["guardian", "contact"]),
  notes: z.string().nullable().optional(),
  contactType: z.enum(["human", "assistant"]),
  lastInteraction: z.number().nullable().optional(),
  interactionCount: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  channels: z.array(contactChannelSchema),
});

// ---------------------------------------------------------------------------
// Contact handlers (transport-agnostic)
// ---------------------------------------------------------------------------

/**
 * Relay a non-search contact list read to the gateway (source of truth for ACL
 * fields). Shared by the GET `contacts` list and the `search_contacts`
 * no-filter case so both serve gateway-sourced data consistently. Fail-closed:
 * a relay failure surfaces as an error rather than reading ACL from the
 * assistant DB.
 */
async function relayListContacts(limit: number, role: ContactRole | undefined) {
  try {
    const result = await ipcCallPersistent("contacts_list_rich", {
      limit,
      ...(role ? { role } : {}),
    });
    const { contacts } = ListContactsIpcResponseSchema.parse(result);
    // Relayed reads carry a gateway-sourced role — trust it (omit guardianIds),
    // so the guardian id set is not consulted here.
    return {
      ok: true,
      contacts: contacts.map((c) => prepareContactResponse(c)),
    };
  } catch (err) {
    rethrowGatewayError(err);
  }
}

/**
 * A daemon-native contact read whose gateway-owned interaction telemetry has
 * been overlaid. `interactionCount` is a count, so it defaults to 0 on the
 * gateway fail-soft/id-miss path (matching the gateway's NOT NULL DEFAULT 0
 * column) — consumers never see `null` and render a real number. The
 * `lastSeenAt`/`lastInteraction` timestamps stay nullable: a "never" timestamp
 * is legitimately absent.
 */
type ContactWithGatewayTelemetry = Omit<ContactWithChannels, "channels"> & {
  interactionCount: number;
  lastInteraction: number | null;
  channels: Array<
    ContactChannel & {
      lastSeenAt: number | null;
      interactionCount: number;
      lastInteraction: number | null;
    }
  >;
};

/**
 * Key channels by (type, lower(address)) for the id-miss telemetry fallback.
 * Matches the gateway's UNIQUE(type, address) NOCASE collation; the NUL
 * delimiter cannot appear in either field, so keys never collide.
 */
function channelKey(type: string, address: string): string {
  return `${type}\u0000${address.toLowerCase()}`;
}

/**
 * Overlay gateway-owned interaction telemetry onto daemon-native contact reads
 * (search / contactType-filtered), which bypass the gateway list relay. The
 * daemon still owns the FILTERING (gateway-native search/contactType is
 * design-blocked), but telemetry (contact + channel
 * interactionCount/lastInteraction, channel lastSeenAt) is gateway-owned — so
 * batch-fetch it via `contacts_list_rich` keyed by the filtered id set and
 * overlay it, keeping the local assistant-DB aggregation out of the served
 * payload. Fail-soft: if the gateway read fails or omits a contact, its
 * interaction counts degrade to 0 and its timestamps to null rather than
 * falling back to the local assistant-DB aggregation.
 */
async function hydrateTelemetryFromGateway(
  contacts: ContactWithChannels[],
): Promise<ContactWithGatewayTelemetry[]> {
  if (contacts.length === 0) return [];

  const gatewayById = new Map<string, ContactRead>();
  try {
    const result = await ipcCallPersistent("contacts_list_rich", {
      ids: contacts.map((c) => c.id),
    });
    const { contacts: rich } = ListContactsIpcResponseSchema.parse(result);
    for (const c of rich) gatewayById.set(c.id, c);
  } catch (err) {
    log.warn(
      { err },
      "hydrateTelemetryFromGateway: gateway telemetry read failed; serving 0 counts / null timestamps",
    );
  }

  return contacts.map((c) => {
    const gw = gatewayById.get(c.id);
    const gwChannelById = new Map(
      (gw?.channels ?? []).map((ch) => [ch.id, ch]),
    );
    // Local channel UUIDs can diverge from the gateway's for the same
    // (type, address) (legacy pre-alignment channels), so an id-miss falls back
    // to a (type, lower(address)) match — mirroring the gateway's
    // overlayAclOntoContacts. UNIQUE(type, address) collates NOCASE gateway-side.
    const gwChannelByTypeAddress = new Map(
      (gw?.channels ?? []).map((ch) => [channelKey(ch.type, ch.address), ch]),
    );
    return {
      ...c,
      interactionCount: gw?.interactionCount ?? 0,
      lastInteraction: gw?.lastInteraction ?? null,
      channels: c.channels.map((ch) => {
        const gwCh =
          gwChannelById.get(ch.id) ??
          gwChannelByTypeAddress.get(channelKey(ch.type, ch.address));
        return {
          ...ch,
          lastSeenAt: gwCh?.lastSeenAt ?? null,
          interactionCount: gwCh?.interactionCount ?? 0,
          lastInteraction: gwCh?.lastInteraction ?? null,
        };
      }),
    };
  });
}

export async function handleListContacts(queryParams: Record<string, string>) {
  const limit = Number(queryParams.limit ?? 50);
  const role = (queryParams.role as ContactRole) || undefined;
  const contactTypeParam = queryParams.contactType;
  const query = queryParams.query || undefined;
  const channelAddress = queryParams.channelAddress || undefined;
  const channelType = queryParams.channelType || undefined;

  if (contactTypeParam && !isContactType(contactTypeParam)) {
    throw new BadRequestError(
      `Invalid contactType "${contactTypeParam}". Must be one of: ${VALID_CONTACT_TYPES.join(", ")}`,
    );
  }

  const contactType = contactTypeParam
    ? (contactTypeParam as ContactType)
    : undefined;

  // True search stays daemon-native: gateway-native search is design-blocked.
  if (query || channelAddress || channelType) {
    log.debug(
      "handleListContacts: search served daemon-native (gateway-native search is design-blocked)",
    );
    // Telemetry hydration and the guardian-id read (for role derivation) both
    // hit the gateway and are independent — run them concurrently.
    const [contacts, guardianIds] = await Promise.all([
      hydrateTelemetryFromGateway(
        searchContacts({
          query,
          channelAddress,
          channelType,
          contactType,
          limit,
        }),
      ),
      getGuardianContactIds(),
    ]);
    return {
      ok: true,
      contacts: contacts.map((c) => prepareContactResponse(c, guardianIds)),
    };
  }

  // contactType is assistant-owned: serve daemon-native so it's filtered in SQL
  // BEFORE the limit. The gateway relay filtered it AFTER its limit, which
  // under-returned (and returned empty on an assistant-DB outage, since the
  // soft-fail map dropped every row). Mirrors the search boundary.
  if (contactType) {
    log.debug(
      "handleListContacts: contactType-filtered read served daemon-native (gateway-native contactType filtering is design-blocked, pending ACL classification)",
    );
    // Telemetry hydration and the guardian-id read (for role derivation) both
    // hit the gateway and are independent — run them concurrently.
    const [contacts, guardianIds] = await Promise.all([
      hydrateTelemetryFromGateway(listContacts(limit, contactType)),
      getGuardianContactIds(),
    ]);
    return {
      ok: true,
      contacts: contacts.map((c) => prepareContactResponse(c, guardianIds)),
    };
  }

  return relayListContacts(limit, role);
}

export async function handleGetContact(contactId: string) {
  try {
    const result = await ipcCallPersistent("contacts_get_rich", { contactId });
    // The gateway returns null (no `contact`) on a clean not-found.
    if (!result || (result as { contact?: unknown }).contact === undefined) {
      throw new NotFoundError(`Contact "${contactId}" not found`);
    }
    const { contact, assistantMetadata } =
      GetContactIpcResponseSchema.parse(result);
    // Relayed read: trust the gateway-sourced role (omit guardianIds).
    return {
      ok: true,
      contact: prepareContactResponse(contact),
      assistantMetadata: assistantMetadata ?? undefined,
    };
  } catch (err) {
    // A clean not-found is a real 404. Any other relay failure fails closed
    // rather than reading ACL from the assistant DB.
    if (err instanceof NotFoundError) throw err;
    rethrowGatewayError(err);
  }
}

// ---------------------------------------------------------------------------
// Invite handlers (transport-agnostic)
// ---------------------------------------------------------------------------

// The gateway owns the canonical invite lifecycle: mint, list, revoke, and
// redemption. These handlers relay via the typed `channels/gateway-invites`
// client (schema-validated responses); the daemon then layers the
// presentation fields (share link, LLM guardian instruction, channel handle)
// onto the gateway's one-time create payload.

export async function handleListInvites({
  queryParams = {},
}: RouteHandlerArgs) {
  try {
    const invites = await listInvites({
      sourceChannel: queryParams.sourceChannel,
      status: queryParams.status,
    });
    return { ok: true, invites };
  } catch (err) {
    rethrowGatewayError(err);
  }
}

export async function handleCreateInvite({ body = {} }: RouteHandlerArgs) {
  const contactId = body.contactId as string;
  const sourceChannel = body.sourceChannel as string | undefined;
  // The guardian display label on voice invites is daemon-resolved and passed
  // through to the gateway, which stores it and never interprets it.
  const guardianName =
    sourceChannel === "phone" ? resolveInviteGuardianName() : undefined;
  let result: { invite: InviteWire; rawToken?: string };
  try {
    result = await createInvite({
      contactId,
      sourceChannel,
      note: body.note as string | undefined,
      maxUses: body.maxUses as number | undefined,
      expiresInMs: body.expiresInMs as number | undefined,
      expectedExternalUserId: body.expectedExternalUserId as
        | string
        | undefined,
      ...(guardianName ? { guardianName } : {}),
      ...(typeof body.sourceConversationId === "string"
        ? { sourceConversationId: body.sourceConversationId }
        : {}),
    });
  } catch (err) {
    rethrowGatewayError(err);
  }
  const invite = await composeInvitePresentation({
    contactId,
    invite: result.invite,
    rawToken: result.rawToken,
  });
  return {
    ok: true,
    invite,
    ...(result.rawToken ? { rawToken: result.rawToken } : {}),
  };
}

export async function handleRevokeInvite({
  pathParams = {},
}: RouteHandlerArgs) {
  try {
    const invite = await revokeInvite(pathParams.id);
    return { ok: true, invite };
  } catch (err) {
    rethrowGatewayError(err);
  }
}

/**
 * Redeem a voice invite code.
 *
 * Backs the HTTP `invites_redeem` route (voice path). Parses the body with
 * the shared `RedeemVoiceInviteRequestSchema` wire contract (plus the
 * daemon-specific `assistantId` passthrough) and relays to the gateway's
 * `invites_redeem` IPC — the gateway redemption engine owns validation, the
 * atomic claim, and the ACL write. Fail-closed: a gateway relay failure
 * surfaces as an error; there is no local redemption fallback.
 */
async function handleRedeemVoiceInvite({ body = {} }: RouteHandlerArgs) {
  const parsed = RedeemVoiceInviteRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError("callerExternalUserId and code are required");
  }

  try {
    return await redeemInviteByVoiceCode({
      ...parsed.data,
      ...(typeof body.assistantId === "string"
        ? { assistantId: body.assistantId }
        : {}),
    });
  } catch (err) {
    rethrowGatewayError(err);
  }
}

/** Map a token-branch schema failure to the stable redeem error messages. */
function redeemTokenIssueMessage(error: z.ZodError): string {
  for (const field of ["token", "sourceChannel"] as const) {
    if (error.issues.some((issue) => issue.path[0] === field)) {
      return `${field} is required`;
    }
  }
  return error.issues[0]?.message ?? "Invalid redemption request";
}

/**
 * Redeem a token invite.
 *
 * Backs the HTTP `invites_redeem` route (token path). Parses the body with
 * the shared `RedeemInviteByTokenRequestSchema` wire contract and relays the
 * parsed request verbatim — including the sender identity fields
 * (`displayName` / `username`) the gateway engine stamps onto the new member —
 * to the gateway's `invites_redeem` IPC. The gateway redemption engine owns
 * validation, the atomic claim, and the ACL write. Fail-closed: a gateway
 * relay failure surfaces as an error; there is no local redemption fallback.
 */
async function handleRedeemTokenInvite({ body = {} }: RouteHandlerArgs) {
  const parsed = RedeemInviteByTokenRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError(redeemTokenIssueMessage(parsed.error));
  }

  try {
    // The `type` is surfaced so callers can tell a real redeem apart from an
    // `already_member` no-op (which consumes no invite use).
    return await redeemInviteByToken(parsed.data);
  } catch (err) {
    rethrowGatewayError(err);
  }
}

export async function handleRedeemInvite(args: RouteHandlerArgs) {
  const body = args.body ?? {};
  if (body.code != null) {
    return handleRedeemVoiceInvite(args);
  }
  return handleRedeemTokenInvite(args);
}

// Stays daemon-local by design (like invites_redeem): the gateway validates
// its canonical invite row, then delegates the actual provider call to THIS
// handler via ipcCallAssistant("invites_trigger_call") with the resolved call
// fields in the body. Relaying back would loop gateway→assistant→gateway.
// The provider call is a daemon capability.
export async function handleTriggerInviteCall({ body = {} }: RouteHandlerArgs) {
  const result = await triggerInviteCall({
    phoneNumber: body.phoneNumber as string | undefined,
    friendName: body.friendName as string | null | undefined,
    guardianName: body.guardianName as string | null | undefined,
  });
  if (!result.ok) {
    throw new BadRequestError(result.error);
  }
  return { ok: true, callSid: result.data.callSid };
}

// ---------------------------------------------------------------------------
// Shared route definitions (HTTP + IPC)
//
// Order matters: contacts/invites/* routes must precede the contacts/:id
// catch-all to avoid the parameterized pattern shadowing literal sub-paths.
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  // ── contacts (exact) ────────────────────────────────────────────────
  {
    operationId: "listContacts",
    endpoint: "contacts",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List contacts",
    description:
      "Return all contacts, optionally filtered by type or channel status.",
    tags: ["contacts"],
    queryParams: [
      {
        name: "limit",
        schema: { type: "integer" },
        description: "Max contacts to return (default 50)",
      },
      {
        name: "role",
        schema: { type: "string" },
        description: "Filter by role (e.g. guardian)",
      },
      {
        name: "contactType",
        schema: { type: "string" },
        description: "Filter by contact type (human or assistant)",
      },
      {
        name: "query",
        schema: { type: "string" },
        description: "Full-text search query",
      },
      {
        name: "channelAddress",
        schema: { type: "string" },
        description: "Filter by channel address",
      },
      {
        name: "channelType",
        schema: { type: "string" },
        description: "Filter by channel type",
      },
    ],
    responseBody: z.object({
      ok: z.boolean(),
      contacts: z
        .array(contactSchema)
        .describe("Contact objects with channels and metadata"),
    }),
    handler: ({ queryParams }: RouteHandlerArgs) =>
      handleListContacts(queryParams ?? {}),
  },

  // ── contacts/invites (must precede contacts/:id) ────────────────────
  // The relayed invite routes' operationIds deliberately reuse the gateway
  // wire method names (single shared map; CLI dispatch uses the same names).
  {
    operationId: INVITES_IPC_METHODS.list,
    endpoint: "contacts/invites",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleListInvites,
    summary: "List invites",
    description:
      "Return all invites, optionally filtered by sourceChannel or status.",
    tags: ["contacts"],
    queryParams: [
      {
        name: "sourceChannel",
        description: "Filter by source channel",
      },
      {
        name: "status",
        description: "Filter by invite status",
      },
    ],
    responseBody: z.object({
      ok: z.boolean(),
      invites: z.array(z.unknown()).describe("Invite objects"),
    }),
  },
  {
    operationId: INVITES_IPC_METHODS.create,
    endpoint: "contacts/invites",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleCreateInvite,
    responseStatus: "201",
    summary: "Create an invite",
    description:
      'Create a new invite. Supports voice invites when sourceChannel is "phone".',
    tags: ["contacts"],
    requestBody: z.object({
      contactId: z.string().describe("Contact to invite"),
      sourceChannel: z
        .string()
        .describe("Source channel (e.g. phone)")
        .optional(),
      note: z.string().describe("Optional note").optional(),
      maxUses: z.number().describe("Max redemptions").optional(),
      expiresInMs: z.number().describe("Expiry duration in ms").optional(),
      expectedExternalUserId: z
        .string()
        .describe("Expected user ID (E.164 for phone)")
        .optional(),
      sourceConversationId: z
        .string()
        .describe("Conversation the invite was created from (opaque)")
        .optional(),
    }),
    responseBody: z.object({
      ok: z.boolean(),
      invite: z.object({}).passthrough().describe("Created invite"),
      rawToken: z
        .string()
        .optional()
        .describe("One-time raw invite token (returned at creation only)"),
    }),
    additionalResponses: {
      "400": {
        description: "Invalid invite parameters",
      },
    },
  },
  {
    // Relays to the gateway `invites_redeem` IPC: the gateway redemption
    // engine is the single lifecycle authority (validation, atomic claim,
    // ACL upsert). Fail-closed when the gateway is unreachable.
    operationId: INVITES_IPC_METHODS.redeem,
    endpoint: "contacts/invites/redeem",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleRedeemInvite,
    summary: "Redeem an invite",
    description: "Redeem an invite by token or voice code.",
    tags: ["contacts"],
    requestBody: z.object({
      token: z
        .string()
        .optional()
        .describe("Invite token (token-based redemption)"),
      code: z.string().optional().describe("Voice code (voice-code redemption)"),
      callerExternalUserId: z
        .string()
        .optional()
        .describe("Caller E.164 phone (voice-code)"),
      externalUserId: z
        .string()
        .optional()
        .describe("External user ID (token-based)"),
      externalChatId: z
        .string()
        .optional()
        .describe("External chat ID (token-based)"),
      sourceChannel: z
        .string()
        .optional()
        .describe("Source channel (token-based)"),
      displayName: z
        .string()
        .optional()
        .describe("Sender display name (token-based)"),
      username: z.string().optional().describe("Sender username (token-based)"),
      assistantId: z.string().optional().describe("Assistant ID (voice-code)"),
    }),
    responseBody: z.object({
      ok: z.boolean(),
      invite: z
        .object({})
        .passthrough()
        .describe("Redeemed invite (token path)"),
      type: z.string().describe("Redemption type (voice path)"),
      memberId: z.string().describe("Member ID (voice path)"),
    }),
    additionalResponses: {
      "400": {
        description: "Invalid redemption parameters or failed redemption",
      },
    },
  },
  {
    operationId: INVITES_IPC_METHODS.revoke,
    endpoint: "contacts/invites/:id",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleRevokeInvite,
    summary: "Revoke an invite",
    description: "Revoke an invite by ID.",
    tags: ["contacts"],
    additionalResponses: {
      "404": {
        description: "Invite not found",
      },
    },
  },
  {
    operationId: "invites_trigger_call",
    endpoint: "contacts/invites/:id/call",
    method: "POST",
    // Gateway-only: the handler dials whatever number is in the body — the
    // invite validation in the gateway's triggerInviteCallNative is the sole
    // gate, so an actor-reachable policy would be an arbitrary-dial primitive.
    policy: {
      requiredScopes: ["internal.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
    handler: handleTriggerInviteCall,
    summary: "Trigger invite call",
    description:
      "Trigger an outbound call for a phone invite. Gateway-only: the gateway validates its canonical invite row and supplies the resolved call fields in the body.",
    tags: ["contacts"],
    requestBody: z.object({
      phoneNumber: z
        .string()
        .describe("E.164 number the invite call dials (invite's bound caller)"),
      friendName: z
        .string()
        .nullable()
        .optional()
        .describe("Invitee display name for the call greeting"),
      guardianName: z
        .string()
        .nullable()
        .optional()
        .describe("Guardian display label recorded on the invite"),
    }),
    responseBody: z.object({
      ok: z.boolean(),
      callSid: z.string().describe("Call SID from the provider"),
    }),
    additionalResponses: {
      "400": {
        description: "Invite not eligible for outbound call",
      },
    },
  },

  // ── contacts/search ──────────────────────────────────────────────────
  {
    operationId: "search_contacts",
    endpoint: "contacts/search",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Search contacts",
    description: "Search contacts by query, channel address, or channel type.",
    tags: ["contacts"],
    requestBody: z.object({
      query: z.string().optional(),
      channelAddress: z.string().optional(),
      channelType: z.string().optional(),
      limit: z.number().optional(),
    }),
    responseBody: z.array(contactSchema),
    handler: async ({ body = {} }: RouteHandlerArgs) => {
      const parsed = z
        .object({
          query: z.string().optional(),
          channelAddress: z.string().optional(),
          channelType: z.string().optional(),
          limit: z.number().optional(),
        })
        .parse(body);

      const hasFilter =
        Boolean(parsed.query?.trim()) ||
        Boolean(parsed.channelAddress) ||
        Boolean(parsed.channelType);

      // No-filter "search" is a list read — relay to the gateway so it returns
      // the same source-of-truth data as `contacts list`.
      if (!hasFilter) {
        const { contacts } = await relayListContacts(
          parsed.limit ?? 50,
          undefined,
        );
        return contacts;
      }

      // True search stays daemon-native: gateway-native search is design-blocked.
      log.debug(
        "search_contacts: search served daemon-native (gateway-native search is design-blocked)",
      );
      // Telemetry hydration and the guardian-id read (for role derivation) both
      // hit the gateway and are independent — run them concurrently.
      const [contacts, guardianIds] = await Promise.all([
        hydrateTelemetryFromGateway(searchContacts(parsed)),
        getGuardianContactIds(),
      ]);
      return contacts.map((c) => prepareContactResponse(c, guardianIds));
    },
  },

  // ── contacts/:id (MUST be last — path param shadows sub-paths) ────
  {
    operationId: "getContact",
    endpoint: "contacts/:id",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get a contact",
    description:
      "Return a single contact with its channels and assistant metadata.",
    tags: ["contacts"],
    responseBody: z.object({
      ok: z.boolean(),
      contact: contactSchema,
      assistantMetadata: z
        .object({
          contactId: z.string(),
          species: z.string(),
          metadata: z.object({}).passthrough().nullable(),
        })
        .optional()
        .describe("Assistant-side metadata"),
    }),
    handler: ({ pathParams }: RouteHandlerArgs) =>
      handleGetContact(pathParams!.id),
  },
  {
    operationId: "merge_contacts",
    endpoint: "contacts/merge",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Merge two contacts",
    description: "Merge two contacts, keeping one and absorbing the other.",
    tags: ["contacts"],
    requestBody: z.object({
      keepId: z.string().describe("ID of the contact to keep"),
      mergeId: z
        .string()
        .describe("ID of the contact to merge into the kept one"),
    }),
    responseBody: z.object({
      ok: z.boolean(),
      contact: contactSchema.describe("Merged contact"),
    }),
    handler: (args: RouteHandlerArgs) => handleMergeContactsRoute(args),
  },
  {
    operationId: "updateContactChannel",
    endpoint: "contact-channels/:contactChannelId",
    method: "PATCH",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Update a contact channel",
    description: "Update status, policy, or reason on a contact's channel.",
    tags: ["contacts"],
    requestBody: z.object({
      status: z.string().optional().describe("Channel status"),
      policy: z.string().optional().describe("Channel policy"),
      reason: z.string().optional().describe("Reason for the change"),
    }),
    responseBody: z.object({
      ok: z.boolean(),
      contact: contactSchema
        .optional()
        .describe("Updated contact (if applicable)"),
    }),
    handler: (args: RouteHandlerArgs) => handleUpdateContactChannelRoute(args),
  },
];

// ---------------------------------------------------------------------------
// Transport-agnostic handlers (moved from HTTP-only)
// ---------------------------------------------------------------------------

async function handleMergeContactsRoute(args: RouteHandlerArgs) {
  const { body } = args;
  const keepId = body?.keepId as string | undefined;
  const mergeId = body?.mergeId as string | undefined;

  if (!keepId || !mergeId) {
    throw new BadRequestError("keepId and mergeId are required");
  }

  try {
    const contact = mergeContacts(keepId, mergeId);
    // Daemon-native read (assistant DB): telemetry is gateway-owned, so overlay
    // it (fail-soft to null) and derive role from the guardian-id set. Both hit
    // the gateway and are independent — run them concurrently.
    const [[hydrated], guardianIds] = await Promise.all([
      hydrateTelemetryFromGateway([contact]),
      getGuardianContactIds(),
    ]);
    return {
      ok: true,
      contact: prepareContactResponse(hydrated, guardianIds),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BadRequestError(message);
  }
}

/**
 * Relay the channel status/policy update to the gateway-native handler.
 *
 * The gateway DB is the source of truth: it owns validation, the
 * revoke-of-blocked guard, the assistant-side channel-ID backward-compat
 * resolution, the assistant-DB mirror, and the `contacts_changed` emit. This
 * daemon handler writes NOTHING to the assistant DB directly — it forwards the
 * raw channel ID + body and returns the gateway response verbatim. No fallback:
 * an unexpected relay failure surfaces as an error (never a silent second
 * write).
 */
export async function handleUpdateContactChannelRoute(args: RouteHandlerArgs) {
  const body = (args.body ?? {}) as {
    status?: string;
    policy?: string;
    reason?: string;
  };

  try {
    const result = await ipcCallPersistent("update_contact_channel", {
      contactChannelId: args.pathParams!.contactChannelId,
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.policy !== undefined ? { policy: body.policy } : {}),
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
    });
    return UpdateContactChannelIpcResponseSchema.parse(result);
  } catch (err) {
    rethrowGatewayError(err);
  }
}
