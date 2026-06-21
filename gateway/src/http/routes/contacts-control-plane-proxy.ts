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
import { ipcCallAssistant } from "../../ipc/assistant-client.js";
import { getLogger } from "../../logger.js";

const log = getLogger("contacts-control-plane-proxy");

// ---------------------------------------------------------------------------
// Validation constants (mirrored from assistant/src/runtime/routes/contact-routes.ts)
// ---------------------------------------------------------------------------

const VALID_CONTACT_TYPES = ["human", "assistant"] as const;

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

    // ── Invite routes ──
    async handleListInvites(req: Request): Promise<Response> {
      const url = new URL(req.url);
      return forward(req, "/v1/contacts/invites", url.search);
    },

    async handleCreateInvite(req: Request): Promise<Response> {
      return forward(req, "/v1/contacts/invites");
    },

    async handleRedeemInvite(req: Request): Promise<Response> {
      return forward(req, "/v1/contacts/invites/redeem");
    },

    async handleCallInvite(req: Request, inviteId: string): Promise<Response> {
      return forward(req, `/v1/contacts/invites/${inviteId}/call`);
    },

    async handleRevokeInvite(
      req: Request,
      inviteId: string,
    ): Promise<Response> {
      return forward(req, `/v1/contacts/invites/${inviteId}`);
    },
  };
}
