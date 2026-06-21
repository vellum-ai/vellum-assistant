/**
 * Gateway proxy endpoints for ingress contacts/invites control-plane routes.
 *
 * These routes are registered as explicit gateway routes for dedicated
 * auth handling rather than falling through to the catch-all proxy.
 */

import { proxyForward } from "@vellumai/assistant-client";
import { eq } from "drizzle-orm";

import { mintServiceToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import {
  assistantDbQuery,
  assistantDbRun,
} from "../../db/assistant-db-proxy.js";
import { getGatewayDb } from "../../db/connection.js";
import {
  ContactStore,
  CannotRevokeBlockedError,
  MergeContactsError,
  type ContactWithInfo,
} from "../../db/contact-store.js";
import { contacts } from "../../db/schema.js";
import { fetchImpl } from "../../fetch.js";
import {
  IpcHandlerError,
  ipcCallAssistant,
} from "../../ipc/assistant-client.js";
import { getLogger } from "../../logger.js";
import {
  parseCreateInviteBody,
  parseListInviteQuery,
  parseRedeemInviteBody,
} from "./invite-validation.js";

const log = getLogger("contacts-control-plane-proxy");

// ---------------------------------------------------------------------------
// Validation constants (mirrored from assistant/src/runtime/routes/contact-routes.ts)
// ---------------------------------------------------------------------------

const VALID_CONTACT_TYPES = ["human", "assistant"] as const;

// ---------------------------------------------------------------------------
// Invite hashing + response sanitization
// ---------------------------------------------------------------------------

/**
 * Strip code/token hashes from a gateway invite row before returning it over
 * HTTP. `inviteCodeHash` is the unsalted SHA-256 of a 6-digit code; returning
 * it lets any list-capable caller brute-force the ~10^6 keyspace offline and
 * redeem an active invite. All invite responses MUST go through this.
 */
function sanitizeInviteRow<T extends { inviteCodeHash?: unknown }>(
  row: T,
): Omit<T, "inviteCodeHash"> {
  const { inviteCodeHash: _omit, ...rest } = row;
  return rest;
}

// ---------------------------------------------------------------------------
// ContactWithInfo -> ContactPayload mapping (gateway-native read path)
// ---------------------------------------------------------------------------

/**
 * Map a gateway-native ContactWithInfo to the wire ContactPayload shape the
 * UI expects (matching assistant/src/daemon/message-types/contacts.ts).
 *
 * Includes the `withChannelCompat` transform: older macOS clients expect
 * `externalUserId` on each channel (= address). The guardian-name override
 * (`withGuardianNameOverride`) is not applied — it reads the guardian persona
 * file which is assistant-side state, not available to the gateway process.
 */
function toContactPayload(c: ContactWithInfo): Record<string, unknown> {
  return {
    id: c.id,
    displayName: c.displayName,
    role: c.role,
    notes: c.notes,
    contactType: c.contactType,
    principalId: c.principalId,
    userFile: c.userFile,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    interactionCount: c.interactionCount,
    lastInteraction: c.lastInteraction,
    assistantMetadata: c.assistantMetadata,
    channels: c.channels.map((ch) => ({
      id: ch.id,
      contactId: ch.contactId,
      type: ch.type,
      address: ch.address,
      isPrimary: ch.isPrimary,
      externalChatId: ch.externalChatId,
      // Compat: externalUserId = address for older macOS clients.
      externalUserId: ch.address,
      status: ch.status,
      policy: ch.policy,
      verifiedAt: ch.verifiedAt,
      verifiedVia: ch.verifiedVia,
      inviteId: ch.inviteId,
      revokedReason: ch.revokedReason,
      blockedReason: ch.blockedReason,
      lastSeenAt: ch.lastSeenAt,
      interactionCount: ch.interactionCount,
      lastInteraction: ch.lastInteraction,
      createdAt: ch.createdAt,
      updatedAt: ch.updatedAt,
    })),
  };
}
const VALID_ASSISTANT_SPECIES = ["vellum"] as const;
const VALID_CHANNEL_STATUSES = [
  "active",
  "pending",
  "revoked",
  "blocked",
  "unverified",
] as const;
const VALID_CHANNEL_POLICIES = ["allow", "deny", "escalate"] as const;

type ContactType = (typeof VALID_CONTACT_TYPES)[number];
type AssistantSpecies = (typeof VALID_ASSISTANT_SPECIES)[number];
type ChannelStatus = (typeof VALID_CHANNEL_STATUSES)[number];
type ChannelPolicy = (typeof VALID_CHANNEL_POLICIES)[number];

function isContactType(v: unknown): v is ContactType {
  return VALID_CONTACT_TYPES.includes(v as ContactType);
}
function isAssistantSpecies(v: unknown): v is AssistantSpecies {
  return VALID_ASSISTANT_SPECIES.includes(v as AssistantSpecies);
}
function isChannelStatus(v: unknown): v is ChannelStatus {
  return VALID_CHANNEL_STATUSES.includes(v as ChannelStatus);
}
function isChannelPolicy(v: unknown): v is ChannelPolicy {
  return VALID_CHANNEL_POLICIES.includes(v as ChannelPolicy);
}

/**
 * Validate that metadata matches the expected shape for the given species.
 * Mirrors `validateSpeciesMetadata` in `assistant/src/contacts/contact-store.ts`.
 */
function validateSpeciesMetadata(
  species: AssistantSpecies,
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  if (metadata == null) return null;

  if (species === "vellum") {
    if (typeof metadata.assistantId !== "string" || !metadata.assistantId) {
      return 'Vellum assistant metadata requires a non-empty "assistantId" string';
    }
    if (typeof metadata.gatewayUrl !== "string" || !metadata.gatewayUrl) {
      return 'Vellum assistant metadata requires a non-empty "gatewayUrl" string';
    }
  }

  return null;
}

export function createContactsControlPlaneProxyHandler(config: GatewayConfig) {
  async function forward(
    req: Request,
    upstreamPath: string,
    upstreamSearch?: string,
  ): Promise<Response> {
    const start = performance.now();
    const result = await proxyForward(req, {
      baseUrl: config.assistantRuntimeBaseUrl,
      path: upstreamPath,
      search: upstreamSearch,
      serviceToken: mintServiceToken(),
      timeoutMs: config.runtimeTimeoutMs,
      fetchImpl,
    });

    const duration = Math.round(performance.now() - start);

    if (result.gatewayError) {
      log.error(
        { path: upstreamPath, duration },
        result.status === 504
          ? "Ingress control-plane proxy upstream timed out"
          : "Ingress control-plane proxy upstream connection failed",
      );
    } else if (result.status >= 400) {
      log.warn(
        { path: upstreamPath, status: result.status, duration },
        "Ingress control-plane proxy upstream error",
      );
    } else {
      log.info(
        { path: upstreamPath, status: result.status, duration },
        "Ingress control-plane proxy completed",
      );
    }

    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
  }

  return {
    // ── Contact CRUD ──
    /**
     * GET /v1/contacts — gateway-native contact list.
     *
     * Reads ACL shape from gateway DB + info shape from assistant DB (single
     * batched join). Falls back to the daemon proxy for search-style queries
     * (query, channelAddress, channelType) which require searchContacts logic
     * not yet implemented in the gateway.
     *
     * Supported natively: limit, role, contactType.
     */
    async handleListContacts(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const role = url.searchParams.get("role") ?? undefined;
      const contactType = url.searchParams.get("contactType") ?? undefined;
      const query = url.searchParams.get("query") ?? undefined;
      const channelAddress = url.searchParams.get("channelAddress") ?? undefined;
      const channelType = url.searchParams.get("channelType") ?? undefined;

      // Validate contactType before any proxy fallback.
      if (contactType && !VALID_CONTACT_TYPES.includes(contactType as never)) {
        return Response.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: `Invalid contactType "${contactType}". Must be one of: ${VALID_CONTACT_TYPES.join(", ")}`,
            },
          },
          { status: 400 },
        );
      }

      // Search-style queries and contactType filter go through the daemon.
      // contactType is an assistant-owned field — the gateway can't filter
      // it without an assistant DB round-trip. The daemon handles it natively.
      if (query || channelAddress || channelType || contactType) {
        return forward(req, "/v1/contacts", url.search);
      }

      try {
        const store = new ContactStore();
        const contacts = await store.listContactsWithInfo({
          limit,
          role: role ?? undefined,
        });
        log.info(
          { count: contacts.length, role, contactType, limit },
          "list_contacts: handled natively",
        );
        return Response.json({
          ok: true,
          contacts: contacts.map(toContactPayload),
        });
      } catch (err) {
        log.error({ err }, "list_contacts: gateway-native read failed, falling back to proxy");
        return forward(req, "/v1/contacts", url.search);
      }
    },

    /**
     * POST /v1/contacts — gateway-native contact upsert.
     *
     * Writes to BOTH the gateway DB (auth/authz fields: id, displayName, role,
     * principalId + channels) and the assistant DB (all fields including notes,
     * userFile, contactType) so the daemon stays in sync during the migration
     * transition period.
     *
     * Resolution order mirrors the assistant's upsertContact:
     *  1. Match by `body.id` if provided.
     *  2. Match by (type, address) on any provided channel.
     *  3. Create a new contact with a generated id.
     */
    async handleUpsertContact(req: Request): Promise<Response> {
      // ── Parse body ──────────────────────────────────────────────────
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return Response.json(
          { error: { code: "BAD_REQUEST", message: "Invalid JSON body" } },
          { status: 400 },
        );
      }

      // ── Validate ────────────────────────────────────────────────────
      if (
        !body.displayName ||
        typeof body.displayName !== "string" ||
        !body.displayName.trim()
      ) {
        return Response.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: "displayName is required and must be a non-empty string",
            },
          },
          { status: 400 },
        );
      }
      const displayName = (body.displayName as string).trim();

      if (body.contactType !== undefined && !isContactType(body.contactType)) {
        return Response.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: `Invalid contactType "${body.contactType}". Must be one of: ${VALID_CONTACT_TYPES.join(", ")}`,
            },
          },
          { status: 400 },
        );
      }

      const assistantMeta = body.assistantMetadata as
        | { species?: unknown; metadata?: unknown }
        | undefined;

      if (body.contactType === "assistant") {
        if (!assistantMeta) {
          return Response.json(
            {
              error: {
                code: "BAD_REQUEST",
                message:
                  'assistantMetadata is required when contactType is "assistant"',
              },
            },
            { status: 400 },
          );
        }
        if (!isAssistantSpecies(assistantMeta.species)) {
          return Response.json(
            {
              error: {
                code: "BAD_REQUEST",
                message: `Invalid species "${assistantMeta.species}". Must be one of: ${VALID_ASSISTANT_SPECIES.join(", ")}`,
              },
            },
            { status: 400 },
          );
        }
        const speciesError = validateSpeciesMetadata(
          assistantMeta.species,
          assistantMeta.metadata as Record<string, unknown> | null | undefined,
        );
        if (speciesError) {
          return Response.json(
            { error: { code: "BAD_REQUEST", message: speciesError } },
            { status: 400 },
          );
        }
      }
      if (body.contactType === "human" && assistantMeta) {
        return Response.json(
          {
            error: {
              code: "BAD_REQUEST",
              message:
                'assistantMetadata must not be provided when contactType is "human"',
            },
          },
          { status: 400 },
        );
      }
      if (assistantMeta && !body.contactType) {
        return Response.json(
          {
            error: {
              code: "BAD_REQUEST",
              message:
                'contactType must be "assistant" when assistantMetadata is provided',
            },
          },
          { status: 400 },
        );
      }

      type ChannelInput = {
        type: string;
        address: string;
        isPrimary?: boolean;
        externalUserId?: string | null;
        externalChatId?: string | null;
        status?: string;
        policy?: string;
      };

      const channelInputs = body.channels as ChannelInput[] | undefined;
      if (channelInputs !== undefined) {
        if (!Array.isArray(channelInputs)) {
          return Response.json(
            {
              error: {
                code: "BAD_REQUEST",
                message: "channels must be an array",
              },
            },
            { status: 400 },
          );
        }
        for (const ch of channelInputs) {
          if (typeof ch?.type !== "string" || !ch.type.trim()) {
            return Response.json(
              {
                error: {
                  code: "BAD_REQUEST",
                  message:
                    "channel.type is required and must be a non-empty string",
                },
              },
              { status: 400 },
            );
          }
          if (typeof ch?.address !== "string" || !ch.address.trim()) {
            return Response.json(
              {
                error: {
                  code: "BAD_REQUEST",
                  message:
                    "channel.address is required and must be a non-empty string",
                },
              },
              { status: 400 },
            );
          }
          if (ch.status !== undefined && !isChannelStatus(ch.status)) {
            return Response.json(
              {
                error: {
                  code: "BAD_REQUEST",
                  message: `Invalid channel status "${ch.status}". Must be one of: ${VALID_CHANNEL_STATUSES.join(", ")}`,
                },
              },
              { status: 400 },
            );
          }
          if (ch.policy !== undefined && !isChannelPolicy(ch.policy)) {
            return Response.json(
              {
                error: {
                  code: "BAD_REQUEST",
                  message: `Invalid channel policy "${ch.policy}". Must be one of: ${VALID_CHANNEL_POLICIES.join(", ")}`,
                },
              },
              { status: 400 },
            );
          }
        }
      }

      // ── Service-layer write (gateway DB + assistant DB dual-write) ───
      //
      // SECURITY: `role` and `principalId` are auth/authz fields. They are
      // NEVER read from the request body. The route is protected by generic
      // edge auth, not a guardian-specific check — accepting these fields
      // from the body would let any authenticated caller rebind the guardian
      // (e.g. POST /v1/contacts with the guardian's id + role:"guardian" +
      // their own principalId). Guardian role is set exclusively through
      // guardian-bootstrap, which uses raw SQL with its own privileged path.
      const store = new ContactStore();
      const { contact, created } = await store.upsertContact({
        id: body.id as string | undefined,
        displayName,
        notes: body.notes as string | null | undefined,
        contactType: body.contactType as string | undefined,
        assistantMetadata:
          body.contactType === "assistant" && assistantMeta
            ? {
                species: assistantMeta.species as string,
                metadata:
                  (assistantMeta.metadata as
                    | Record<string, unknown>
                    | null
                    | undefined) ?? null,
              }
            : undefined,
        channels: channelInputs?.map((ch) => ({
          type: ch.type,
          address: ch.address,
          isPrimary: ch.isPrimary,
          externalChatId: ch.externalChatId ?? null,
          status: ch.status,
          policy: ch.policy,
        })),
      });

      // ── Emit contacts_changed ────────────────────────────────────────
      void ipcCallAssistant("emit_event", {
        body: { kind: "contacts_changed" },
      } as unknown as Record<string, unknown>).catch(() => {});

      log.info(
        { contactId: contact.id, created },
        "upsert_contact: handled natively",
      );
      return Response.json({ ok: true, contact });
    },

    /**
     * GET /v1/contacts/:id — gateway-native single contact read.
     *
     * Reads ACL shape from gateway DB + info shape from assistant DB. Falls
     * back to the daemon proxy if the gateway-native read throws.
     */
    async handleGetContact(req: Request, contactId: string): Promise<Response> {
      try {
        const store = new ContactStore();
        const contact = await store.getContactWithInfo(contactId);
        if (!contact) {
          return Response.json(
            {
              error: {
                code: "NOT_FOUND",
                message: `Contact "${contactId}" not found`,
              },
            },
            { status: 404 },
          );
        }
        log.info({ contactId }, "get_contact: handled natively");

        // Match the daemon's response shape: { ok, contact, assistantMetadata }
        const payload = toContactPayload(contact);
        const assistantMetadata =
          contact.contactType === "assistant" && contact.assistantMetadata
            ? {
                contactId: contact.id,
                species: contact.assistantMetadata.species,
                metadata: contact.assistantMetadata.metadata,
              }
            : undefined;
        return Response.json({
          ok: true,
          contact: payload,
          assistantMetadata: assistantMetadata ?? undefined,
        });
      } catch (err) {
        log.error({ err, contactId }, "get_contact: gateway-native read failed, falling back to proxy");
        return forward(req, `/v1/contacts/${contactId}`);
      }
    },

    async handleDeleteContact(contactId: string): Promise<Response> {
      const rows = await assistantDbQuery<{ role: string }>(
        "SELECT role FROM contacts WHERE id = ?",
        [contactId],
      );
      if (rows.length === 0) {
        log.warn({ contactId }, "delete_contact: not found");
        return Response.json(
          {
            error: {
              code: "NOT_FOUND",
              message: `Contact "${contactId}" not found`,
            },
          },
          { status: 404 },
        );
      }
      if (rows[0].role === "guardian") {
        log.warn({ contactId }, "delete_contact: attempted to delete guardian");
        return Response.json(
          {
            error: {
              code: "FORBIDDEN",
              message: "Cannot delete a guardian contact",
            },
          },
          { status: 403 },
        );
      }
      await assistantDbRun("DELETE FROM contacts WHERE id = ?", [contactId]);
      getGatewayDb().delete(contacts).where(eq(contacts.id, contactId)).run();
      void ipcCallAssistant("emit_event", {
        body: { kind: "contacts_changed" },
      } as unknown as Record<string, unknown>).catch(() => {});
      log.info({ contactId }, "delete_contact: deleted");
      return new Response(null, { status: 204 });
    },

    /**
     * POST /v1/contacts/merge — gateway-native contact merge.
     *
     * Moves channels from donor to survivor, deletes the donor in the
     * gateway DB (single transaction), then best-effort concatenates notes
     * and deletes the donor in the assistant DB. Returns the survivor
     * contact with channels + info.
     *
     * No proxy fallback: the body is already consumed by req.json(), and
     * falling back to the daemon would create split-brain (daemon moves
     * channels in assistant DB while gateway DB is stale).
     */
    async handleMergeContacts(req: Request): Promise<Response> {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return Response.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: "Request body must be valid JSON",
            },
          },
          { status: 400 },
        );
      }

      const keepId = body.keepId as string | undefined;
      const mergeId = body.mergeId as string | undefined;

      if (!keepId || !mergeId) {
        return Response.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: "keepId and mergeId are required",
            },
          },
          { status: 400 },
        );
      }

      try {
        const store = new ContactStore();
        const contact = await store.mergeContacts(keepId, mergeId);

        // Emit contacts_changed so connected clients refresh.
        void ipcCallAssistant("emit_event", {
          body: { kind: "contacts_changed" },
        } as unknown as Record<string, unknown>).catch(() => {});

        log.info({ keepId, mergeId }, "merge_contacts: handled natively");
        return Response.json({
          ok: true,
          contact: contact ? toContactPayload(contact) : undefined,
        });
      } catch (err) {
        if (err instanceof MergeContactsError) {
          return Response.json(
            {
              error: {
                code: "BAD_REQUEST",
                message: err.message,
              },
            },
            { status: 400 },
          );
        }
        log.error(
          { keepId, mergeId, err },
          "merge_contacts: gateway-native merge failed",
        );
        return Response.json(
          {
            error: {
              code: "INTERNAL_ERROR",
              message: "Failed to merge contacts",
            },
          },
          { status: 500 },
        );
      }
    },

    /**
     * PATCH /v1/contact-channels/:id — gateway-native channel status/policy
     * update.
     *
     * Updates the channel in the gateway DB (ACL source of truth) and
     * best-effort dual-writes to the assistant DB. Returns the parent
     * contact via getContactWithInfo so the UI gets the full updated shape.
     */
    async handleUpdateContactChannel(
      req: Request,
      contactChannelId: string,
    ): Promise<Response> {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return Response.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: "Request body must be valid JSON",
            },
          },
          { status: 400 },
        );
      }

      const status = body.status as string | undefined;
      const policy = body.policy as string | undefined;
      const reason = (body.reason as string | null | undefined) ?? null;

      if (status !== undefined && !isChannelStatus(status)) {
        return Response.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: `Invalid status "${status}". Must be one of: ${VALID_CHANNEL_STATUSES.join(", ")}`,
            },
          },
          { status: 400 },
        );
      }

      if (policy !== undefined && !isChannelPolicy(policy)) {
        return Response.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: `Invalid policy "${policy}". Must be one of: ${VALID_CHANNEL_POLICIES.join(", ")}`,
            },
          },
          { status: 400 },
        );
      }

      if (status === undefined && policy === undefined) {
        return Response.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: "At least one of status or policy must be provided",
            },
          },
          { status: 400 },
        );
      }

      try {
        const store = new ContactStore();
        const updated = await store.updateChannelStatus(contactChannelId, {
          status,
          policy,
          reason,
        });

        if (!updated) {
          return Response.json(
            {
              error: {
                code: "NOT_FOUND",
                message: `Channel "${contactChannelId}" not found`,
              },
            },
            { status: 404 },
          );
        }

        // Best-effort dual-write to assistant DB.
        const dualWriteParams: {
          status?: string;
          policy?: string;
          revokedReason?: string | null;
          blockedReason?: string | null;
        } = {};
        if (status !== undefined) {
          dualWriteParams.status = status;
          dualWriteParams.revokedReason =
            status === "revoked" ? reason : null;
          dualWriteParams.blockedReason =
            status === "blocked" ? reason : null;
        }
        if (policy !== undefined) dualWriteParams.policy = policy;

        try {
          await store.dualWriteChannelStatusToAssistantDb(
            contactChannelId,
            dualWriteParams,
          );
        } catch (err) {
          log.warn(
            { contactChannelId, err },
            "update_channel: assistant DB dual-write failed (best-effort)",
          );
        }

        // Emit contacts_changed so connected clients refresh.
        void ipcCallAssistant("emit_event", {
          body: { kind: "contacts_changed" },
        } as unknown as Record<string, unknown>).catch(() => {});

        // Return the parent contact with info join, matching the daemon's
        // response shape.
        const contact = await store.getContactWithInfo(updated.contactId);
        log.info(
          { contactChannelId, contactId: updated.contactId, status, policy },
          "update_channel: handled natively",
        );
        return Response.json({
          ok: true,
          contact: contact ? toContactPayload(contact) : undefined,
        });
      } catch (err) {
        if (err instanceof CannotRevokeBlockedError) {
          return Response.json(
            {
              error: {
                code: "CONFLICT",
                message: err.message,
              },
            },
            { status: 409 },
          );
        }
        log.error(
          { contactChannelId, err },
          "update_channel: gateway-native update failed",
        );
        return Response.json(
          {
            error: {
              code: "INTERNAL_ERROR",
              message: "Failed to update channel",
            },
          },
          { status: 500 },
        );
      }
    },

    /**
     * POST /v1/contact-channels/:id/verify — guardian-only manual verify.
     *
     * Gateway-native + dual-write: the channel mutation happens in the
     * gateway DB first (source of truth); a best-effort mirror is written
     * to the assistant DB so the daemon stays in sync during the
     * gateway-security-migration transition period.
     *
     * Migration-window backfill: when the gateway DB has never seen the
     * channel but the assistant DB has it, the channel (and its parent
     * contact) is mirrored into the gateway before the verify write so the
     * user-visible channel id from the assistant UI doesn't 404 here.
     *
     * Idempotent: a row that's already active+verifiedVia=manual returns
     * the same shape (200 with channel) but no second write occurs.
     */
    async handleVerifyContactChannel(
      _req: Request,
      contactChannelId: string,
    ): Promise<Response> {
      const result = await new ContactStore().markChannelVerified(
        contactChannelId,
      );
      if (!result) {
        return Response.json(
          {
            error: {
              code: "NOT_FOUND",
              message: `Channel "${contactChannelId}" not found`,
            },
          },
          { status: 404 },
        );
      }
      log.info(
        {
          contactChannelId,
          didWrite: result.didWrite,
          status: result.channel.status,
        },
        "manual_verify: channel attested verified by guardian",
      );
      return Response.json({ ok: true, channel: result.channel });
    },

    // ── Invite routes (gateway-native) ──
    //
    // The gateway DB's ingress_invites is the source of truth for invite
    // lifecycle. Token mint, voice/token redemption, and outbound call relay
    // to the assistant over IPC (token secrecy + voice UX are assistant-owned);
    // the gateway records the canonical ACL-relevant lifecycle. None of these
    // handlers fall back to `forward` on error — mutations 500 instead.

    /**
     * GET /v1/contacts/invites — gateway-native invite list.
     *
     * Reads invite rows from the gateway DB (source of truth) and best-effort
     * joins voice UX fields (voiceCode digits, friendName, etc.) from the
     * assistant DB keyed on invite id. If the assistant join throws, returns
     * the gateway rows without voice fields (stale over lost).
     */
    async handleListInvites(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const query = parseListInviteQuery(url.searchParams);

      try {
        const rows = new ContactStore().listInvites(query);

        // Best-effort: join voice UX fields from the assistant DB.
        const voiceById = new Map<string, Record<string, unknown>>();
        if (rows.length > 0) {
          try {
            const ids = rows.map((r) => r.id);
            const placeholders = ids.map(() => "?").join(", ");
            const voiceRows = await assistantDbQuery<{
              id: string;
              voiceCodeDigits: number | null;
              friendName: string | null;
              guardianName: string | null;
              expectedExternalUserId: string | null;
            }>(
              `SELECT id,
                      voice_code_digits        AS voiceCodeDigits,
                      friend_name              AS friendName,
                      guardian_name            AS guardianName,
                      expected_external_user_id AS expectedExternalUserId
                 FROM assistant_ingress_invites
                WHERE id IN (${placeholders})`,
              ids,
            );
            for (const v of voiceRows) {
              voiceById.set(v.id, {
                ...(v.voiceCodeDigits != null
                  ? { voiceCodeDigits: v.voiceCodeDigits }
                  : {}),
                ...(v.friendName ? { friendName: v.friendName } : {}),
                ...(v.guardianName ? { guardianName: v.guardianName } : {}),
                ...(v.expectedExternalUserId
                  ? { expectedExternalUserId: v.expectedExternalUserId }
                  : {}),
              });
            }
          } catch (err) {
            log.warn(
              { err, count: rows.length },
              "list_invites: assistant DB voice-field join failed; returning gateway rows only",
            );
          }
        }

        const invites = rows.map((r) => ({
          ...sanitizeInviteRow(r),
          ...(voiceById.get(r.id) ?? {}),
        }));
        log.info(
          { count: invites.length, ...query },
          "list_invites: handled natively",
        );
        return Response.json({ ok: true, invites });
      } catch (err) {
        log.error({ err }, "list_invites: gateway-native read failed");
        return Response.json(
          {
            error: { code: "INTERNAL_ERROR", message: "Failed to list invites" },
          },
          { status: 500 },
        );
      }
    },

    /**
     * POST /v1/contacts/invites — gateway-native invite create.
     *
     * Inverted dual-write vs contacts: the assistant mints first (it owns
     * token secrecy + voice UX, writes voice fields, returns the raw token +
     * projection), then the gateway records the canonical lifecycle row in its
     * own DB (source of truth for ACL). If the gateway write throws → 500, no
     * fallback: the assistant row already existing is stale-over-lost.
     */
    async handleCreateInvite(req: Request): Promise<Response> {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json(
          { error: { code: "BAD_REQUEST", message: "Invalid JSON body" } },
          { status: 400 },
        );
      }

      const parsed = parseCreateInviteBody(body);
      if (!parsed.ok) {
        return Response.json(
          { error: { code: "BAD_REQUEST", message: parsed.message } },
          { status: 400 },
        );
      }
      const input = parsed.value;
      const store = new ContactStore();

      // Verify the contact exists in the gateway DB before minting.
      if (!store.getContact(input.contactId)) {
        return Response.json(
          {
            error: {
              code: "NOT_FOUND",
              message: `Contact "${input.contactId}" not found`,
            },
          },
          { status: 404 },
        );
      }

      // ── Assistant mints (token/hash + voice fields) ──────────────────
      let mint: {
        invite: Record<string, unknown>;
        rawToken?: string;
        gateway: {
          id: string;
          inviteCodeHash: string;
          sourceChannel: string;
          contactId: string;
          note: string | null;
          maxUses: number;
          expiresAt: number;
        };
      };
      try {
        mint = (await ipcCallAssistant("invites_mint", {
          body: input,
        } as unknown as Record<string, unknown>)) as typeof mint;
      } catch (err) {
        if (err instanceof IpcHandlerError) {
          return Response.json(
            {
              error: {
                code: err.code,
                message: err.message,
              },
            },
            { status: err.statusCode },
          );
        }
        log.error({ err, contactId: input.contactId }, "create_invite: mint failed");
        return Response.json(
          {
            error: { code: "INTERNAL_ERROR", message: "Failed to mint invite" },
          },
          { status: 500 },
        );
      }

      // ── Gateway DB write (source of truth) ───────────────────────────
      const gw = mint.gateway;
      let invite;
      try {
        invite = store.createInvite({
          id: gw.id,
          inviteCodeHash: gw.inviteCodeHash,
          sourceChannel: gw.sourceChannel,
          contactId: gw.contactId,
          note: gw.note,
          maxUses: gw.maxUses,
          expiresAt: gw.expiresAt,
        });
      } catch (err) {
        // The assistant already minted a row; the gateway record is what
        // gates ACL, so a missing gateway row is a hard failure. No fallback.
        log.error(
          { err, inviteId: gw?.id, contactId: input.contactId },
          "create_invite: gateway DB write failed — assistant invite row is now orphaned (stale over lost)",
        );
        return Response.json(
          {
            error: { code: "INTERNAL_ERROR", message: "Failed to record invite" },
          },
          { status: 500 },
        );
      }

      // Notify connected clients.
      void ipcCallAssistant("emit_event", {
        body: { kind: "contacts_changed" },
      } as unknown as Record<string, unknown>).catch(() => {});

      log.info(
        { inviteId: invite.id, contactId: input.contactId },
        "create_invite: handled natively",
      );
      // The gateway row is the lifecycle source of truth, but the HTTP response
      // must carry the assistant's minted one-time fields (voiceCode for phone;
      // inviteCode/guardianInstruction/share/token for non-phone) — these are
      // returned only at creation time and can never be fetched later.
      return Response.json(
        { ok: true, invite: mint.invite, rawToken: mint.rawToken },
        { status: 201 },
      );
    },

    /**
     * POST /v1/contacts/invites/redeem — gateway-native invite redeem.
     *
     * Voice and token redemption relay to the assistant (it owns the
     * identity-bound voice code path + token hash lookup); the gateway mirrors
     * the canonical redemption into its own DB (best-effort) so the invite
     * lifecycle stays consistent.
     */
    async handleRedeemInvite(req: Request): Promise<Response> {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json(
          { error: { code: "BAD_REQUEST", message: "Invalid JSON body" } },
          { status: 400 },
        );
      }

      const parsed = parseRedeemInviteBody(body);
      if (!parsed.ok) {
        return Response.json(
          { error: { code: "BAD_REQUEST", message: parsed.message } },
          { status: 400 },
        );
      }
      const input = parsed.value;

      // Thin relay: the assistant redemption service now owns the authoritative
      // gateway claim (record_invite_redemption, by id, caller-scoped) for ALL
      // paths — including this HTTP one, since it relays into the same assistant
      // redeem handlers. Re-claiming here would double-count uses, so the gateway
      // handler just parses, relays, and returns.
      try {
        if (input.kind === "voice") {
          const result = (await ipcCallAssistant("invites_redeem_voice", {
            body: {
              code: input.code,
              callerExternalUserId: input.callerExternalUserId,
              ...(input.assistantId ? { assistantId: input.assistantId } : {}),
            },
          } as unknown as Record<string, unknown>)) as {
            type: string;
            memberId?: string;
            inviteId?: string;
          };

          log.info(
            { type: result.type, inviteId: result.inviteId },
            "redeem_invite(voice): relayed to assistant",
          );
          return Response.json({
            ok: true,
            type: result.type,
            memberId: result.memberId,
            ...(result.inviteId ? { inviteId: result.inviteId } : {}),
          });
        }

        const result = (await ipcCallAssistant("invites_redeem_token", {
          body: {
            token: input.token,
            sourceChannel: input.sourceChannel,
            ...(input.externalUserId
              ? { externalUserId: input.externalUserId }
              : {}),
            ...(input.externalChatId
              ? { externalChatId: input.externalChatId }
              : {}),
          },
        } as unknown as Record<string, unknown>)) as {
          invite: { id: string };
          type?: string;
        };

        log.info(
          { inviteId: result.invite.id },
          "redeem_invite(token): relayed to assistant",
        );
        return Response.json({ ok: true, invite: result.invite });
      } catch (err) {
        if (err instanceof IpcHandlerError) {
          return Response.json(
            { error: { code: err.code, message: err.message } },
            { status: err.statusCode },
          );
        }
        log.error({ err }, "redeem_invite: relay failed");
        return Response.json(
          {
            error: {
              code: "INTERNAL_ERROR",
              message: "Failed to redeem invite",
            },
          },
          { status: 500 },
        );
      }
    },

    /**
     * POST /v1/contacts/invites/:id/call — gateway-native outbound call relay.
     *
     * Verifies the invite exists + is active in the gateway DB (source of
     * truth for lifecycle), then relays the provider-specific call to the
     * assistant. The gateway gates; the assistant places the call.
     */
    async handleCallInvite(_req: Request, inviteId: string): Promise<Response> {
      const invite = new ContactStore().getInviteById(inviteId);
      if (!invite) {
        return Response.json(
          {
            error: {
              code: "NOT_FOUND",
              message: `Invite "${inviteId}" not found`,
            },
          },
          { status: 404 },
        );
      }
      if (invite.status !== "active") {
        return Response.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: `Invite "${inviteId}" is not active`,
            },
          },
          { status: 400 },
        );
      }

      try {
        // `invites_trigger_call` is the shared assistant route handler
        // (handleTriggerInviteCall), which reads the id from pathParams.id. The
        // assistant IPC server spreads `params` directly into RouteHandlerArgs,
        // so send it as pathParams — not body.
        const result = (await ipcCallAssistant("invites_trigger_call", {
          pathParams: { id: inviteId },
        } as unknown as Record<string, unknown>)) as { callSid: string };
        log.info(
          { inviteId, callSid: result.callSid },
          "call_invite: handled natively",
        );
        return Response.json({ ok: true, callSid: result.callSid });
      } catch (err) {
        if (err instanceof IpcHandlerError) {
          return Response.json(
            { error: { code: err.code, message: err.message } },
            { status: err.statusCode },
          );
        }
        log.error({ err, inviteId }, "call_invite: relay failed");
        return Response.json(
          {
            error: {
              code: "INTERNAL_ERROR",
              message: "Failed to trigger invite call",
            },
          },
          { status: 500 },
        );
      }
    },

    /**
     * DELETE /v1/contacts/invites/:id — gateway-native invite revoke.
     *
     * Revokes the invite in the gateway DB (source of truth). 404 if the id
     * is unknown. Best-effort mirror of the revoke into the assistant DB.
     */
    async handleRevokeInvite(
      _req: Request,
      inviteId: string,
    ): Promise<Response> {
      try {
        const invite = new ContactStore().revokeInvite(inviteId);
        if (!invite) {
          return Response.json(
            {
              error: {
                code: "NOT_FOUND",
                message: `Invite "${inviteId}" not found`,
              },
            },
            { status: 404 },
          );
        }

        // Best-effort mirror into the assistant DB.
        try {
          await assistantDbRun(
            "UPDATE assistant_ingress_invites SET status='revoked', updated_at=? WHERE id=?",
            [Date.now(), inviteId],
          );
        } catch (err) {
          log.warn(
            { err, inviteId },
            "revoke_invite: assistant DB mirror failed (best-effort)",
          );
        }

        void ipcCallAssistant("emit_event", {
          body: { kind: "contacts_changed" },
        } as unknown as Record<string, unknown>).catch(() => {});

        log.info({ inviteId }, "revoke_invite: handled natively");
        return Response.json({ ok: true, invite: sanitizeInviteRow(invite) });
      } catch (err) {
        log.error({ err, inviteId }, "revoke_invite: gateway-native revoke failed");
        return Response.json(
          {
            error: {
              code: "INTERNAL_ERROR",
              message: "Failed to revoke invite",
            },
          },
          { status: 500 },
        );
      }
    },
  };
}
