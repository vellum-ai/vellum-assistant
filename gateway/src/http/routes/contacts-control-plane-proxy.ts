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
import { ContactStore } from "../../db/contact-store.js";
import { contacts } from "../../db/schema.js";
import { fetchImpl } from "../../fetch.js";
import { ipcCallAssistant } from "../../ipc/assistant-client.js";
import { getLogger } from "../../logger.js";

const log = getLogger("contacts-control-plane-proxy");

// ---------------------------------------------------------------------------
// Validation constants (mirrored from assistant/src/runtime/routes/contact-routes.ts)
// ---------------------------------------------------------------------------

const VALID_CONTACT_TYPES = ["human", "assistant"] as const;
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
    async handleListContacts(req: Request): Promise<Response> {
      const url = new URL(req.url);
      return forward(req, "/v1/contacts", url.search);
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
              message:
                "displayName is required and must be a non-empty string",
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
          assistantMeta.metadata as
            | Record<string, unknown>
            | null
            | undefined,
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
          externalUserId: ch.externalUserId ?? null,
          externalChatId: ch.externalChatId ?? null,
          status: ch.status,
          policy: ch.policy,
        })),
      });

      // ── Emit contacts_changed ────────────────────────────────────────
      void ipcCallAssistant("emit_event", {
        body: { kind: "contacts_changed" },
      } as unknown as Record<string, unknown>).catch(() => {});

      log.info({ contactId: contact.id, created }, "upsert_contact: handled natively");
      return Response.json({ ok: true, contact });
    },

    async handleGetContact(req: Request, contactId: string): Promise<Response> {
      return forward(req, `/v1/contacts/${contactId}`);
    },

    async handleDeleteContact(contactId: string): Promise<Response> {
      const rows = await assistantDbQuery<{ role: string }>(
        "SELECT role FROM contacts WHERE id = ?",
        [contactId],
      );
      if (rows.length === 0) {
        log.warn({ contactId }, "delete_contact: not found");
        return Response.json(
          { error: { code: "NOT_FOUND", message: `Contact "${contactId}" not found` } },
          { status: 404 },
        );
      }
      if (rows[0].role === "guardian") {
        log.warn({ contactId }, "delete_contact: attempted to delete guardian");
        return Response.json(
          { error: { code: "FORBIDDEN", message: "Cannot delete a guardian contact" } },
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

    async handleMergeContacts(req: Request): Promise<Response> {
      return forward(req, "/v1/contacts/merge");
    },

    async handleUpdateContactChannel(
      req: Request,
      contactChannelId: string,
    ): Promise<Response> {
      return forward(req, `/v1/contact-channels/${contactChannelId}`);
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
      const result =
        await new ContactStore().markChannelVerified(contactChannelId);
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
