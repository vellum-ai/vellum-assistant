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
  type SqliteValue,
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
const VALID_ASSISTANT_SPECIES = ["vellum", "openclaw"] as const;
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

// ---------------------------------------------------------------------------
// userFile slug helper
// ---------------------------------------------------------------------------

/**
 * Compute a unique `user_file` slug for a new contact.
 *
 * Mirrors the assistant's generateUserFileSlug: converts displayName to a
 * lowercase kebab slug, queries the assistant DB for collisions, and adds a
 * numeric suffix if necessary.
 */
async function resolveAssistantUserFileSlug(
  displayName: string,
): Promise<string> {
  const slug =
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || "user";

  const rows = await assistantDbQuery<{ userFile: string | null }>(
    "SELECT user_file AS userFile FROM contacts WHERE user_file LIKE ?",
    [`${slug}%`],
  );
  const taken = new Set(
    rows.map((r) => r.userFile?.toLowerCase()).filter(Boolean),
  );

  const base = `${slug}.md`;
  if (!taken.has(base)) return base;

  for (let i = 2; i <= 100; i++) {
    const candidate = `${slug}-${i}.md`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${slug}-${crypto.randomUUID().slice(0, 8)}.md`;
}

// ---------------------------------------------------------------------------
// Assistant DB response builder
// ---------------------------------------------------------------------------

interface AssistantContactRow {
  id: string;
  displayName: string;
  notes: string | null;
  role: string;
  contactType: string;
  principalId: string | null;
  userFile: string | null;
  createdAt: number;
  updatedAt: number;
  channelId: string | null;
  channelType: string | null;
  address: string | null;
  isPrimary: number | null;
  externalUserId: string | null;
  externalChatId: string | null;
  channelStatus: string | null;
  channelPolicy: string | null;
  verifiedAt: number | null;
  verifiedVia: string | null;
  inviteId: string | null;
  revokedReason: string | null;
  blockedReason: string | null;
  lastSeenAt: number | null;
  interactionCount: number | null;
  lastInteraction: number | null;
  channelCreatedAt: number | null;
  channelUpdatedAt: number | null;
}

/**
 * Read a contact + channels from the assistant DB and build the
 * ContactWithChannels response shape that callers expect.
 */
async function readAssistantContact(
  contactId: string,
): Promise<Record<string, unknown> | null> {
  const rows = await assistantDbQuery<AssistantContactRow>(
    `SELECT c.id,
            c.display_name      AS displayName,
            c.notes,
            c.role,
            c.contact_type      AS contactType,
            c.principal_id      AS principalId,
            c.user_file         AS userFile,
            c.created_at        AS createdAt,
            c.updated_at        AS updatedAt,
            cc.id               AS channelId,
            cc.type             AS channelType,
            cc.address,
            cc.is_primary       AS isPrimary,
            cc.external_user_id AS externalUserId,
            cc.external_chat_id AS externalChatId,
            cc.status           AS channelStatus,
            cc.policy           AS channelPolicy,
            cc.verified_at      AS verifiedAt,
            cc.verified_via     AS verifiedVia,
            cc.invite_id        AS inviteId,
            cc.revoked_reason   AS revokedReason,
            cc.blocked_reason   AS blockedReason,
            cc.last_seen_at     AS lastSeenAt,
            cc.interaction_count AS interactionCount,
            cc.last_interaction  AS lastInteraction,
            cc.created_at       AS channelCreatedAt,
            cc.updated_at       AS channelUpdatedAt
     FROM contacts c
     LEFT JOIN contact_channels cc ON cc.contact_id = c.id
     WHERE c.id = ?
     ORDER BY cc.is_primary DESC, cc.created_at ASC`,
    [contactId],
  );

  if (!rows.length) return null;

  const first = rows[0];
  const channels = rows
    .filter((r) => r.channelId !== null)
    .map((r) => ({
      id: r.channelId!,
      contactId,
      type: r.channelType!,
      address: r.address!,
      isPrimary: Boolean(r.isPrimary),
      externalUserId: r.externalUserId,
      externalChatId: r.externalChatId,
      status: r.channelStatus,
      policy: r.channelPolicy,
      verifiedAt: r.verifiedAt,
      verifiedVia: r.verifiedVia,
      inviteId: r.inviteId,
      revokedReason: r.revokedReason,
      blockedReason: r.blockedReason,
      lastSeenAt: r.lastSeenAt,
      interactionCount: r.interactionCount ?? 0,
      lastInteraction: r.lastInteraction,
      createdAt: r.channelCreatedAt,
      updatedAt: r.channelUpdatedAt,
    }));

  const interactionCount = channels.reduce(
    (sum, ch) => sum + (ch.interactionCount ?? 0),
    0,
  );
  const lastInteraction =
    channels.reduce(
      (max, ch) => Math.max(max, ch.lastInteraction ?? 0),
      0,
    ) || null;

  return {
    id: first.id,
    displayName: first.displayName,
    notes: first.notes,
    role: first.role,
    contactType: first.contactType,
    principalId: first.principalId,
    userFile: first.userFile,
    createdAt: first.createdAt,
    updatedAt: first.updatedAt,
    interactionCount,
    lastInteraction,
    channels,
  };
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

      // ── Gateway DB write ─────────────────────────────────────────────
      const store = new ContactStore();
      const { contact, created } = store.upsertContact({
        id: body.id as string | undefined,
        displayName,
        role: body.role as string | undefined,
        principalId: body.principalId as string | null | undefined,
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
      const contactId = contact.id;
      const now = Date.now();

      // ── Assistant DB dual-write ──────────────────────────────────────
      try {
        // Check whether the contact already exists in the assistant DB so we
        // know whether to INSERT or UPDATE (and whether to compute userFile).
        const existing = await assistantDbQuery<{ userFile: string | null }>(
          "SELECT user_file AS userFile FROM contacts WHERE id = ?",
          [contactId],
        );

        if (existing.length) {
          // UPDATE — preserve user_file and created_at.
          await assistantDbRun(
            `UPDATE contacts
               SET display_name = ?,
                   notes        = ?,
                   role         = ?,
                   contact_type = ?,
                   principal_id = ?,
                   updated_at   = ?
             WHERE id = ?`,
            [
              displayName,
              (body.notes as string | null | undefined) ?? null,
              (body.role as string | undefined) ?? "contact",
              (body.contactType as string | undefined) ?? "human",
              (body.principalId as string | null | undefined) ?? null,
              now,
              contactId,
            ],
          );
        } else {
          // INSERT — compute a unique user_file slug.
          const userFile = await resolveAssistantUserFileSlug(displayName);
          await assistantDbRun(
            `INSERT INTO contacts
               (id, display_name, notes, role, contact_type, principal_id,
                user_file, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              contactId,
              displayName,
              (body.notes as string | null | undefined) ?? null,
              (body.role as string | undefined) ?? "contact",
              (body.contactType as string | undefined) ?? "human",
              (body.principalId as string | null | undefined) ?? null,
              userFile,
              now,
              now,
            ],
          );
        }

        // Assistant contact metadata (assistant-type contacts only).
        if (body.contactType === "assistant" && assistantMeta) {
          await assistantDbRun(
            `INSERT INTO assistant_contact_metadata (contact_id, species, metadata)
             VALUES (?, ?, ?)
             ON CONFLICT(contact_id) DO UPDATE SET
               species  = excluded.species,
               metadata = excluded.metadata`,
            [
              contactId,
              assistantMeta.species as string,
              assistantMeta.metadata != null
                ? JSON.stringify(assistantMeta.metadata)
                : null,
            ],
          );
        }

        // Sync channels to assistant DB.
        for (const ch of channelInputs ?? []) {
          const address = ch.address.toLowerCase();

          const existingCh = await assistantDbQuery<{
            id: string;
            status: string;
          }>(
            "SELECT id, status FROM contact_channels WHERE contact_id = ? AND type = ? AND address = ?",
            [contactId, ch.type, address],
          );

          if (existingCh.length) {
            const isBlocked = existingCh[0].status === "blocked";
            const setParts: string[] = [
              "external_user_id = ?",
              "external_chat_id = ?",
              "updated_at = ?",
            ];
            const setParams: SqliteValue[] = [
              ch.externalUserId ?? null,
              ch.externalChatId ?? null,
              now,
            ];
            if (!isBlocked) {
              if (ch.status !== undefined) {
                setParts.push("status = ?");
                setParams.push(ch.status);
              }
              if (ch.policy !== undefined) {
                setParts.push("policy = ?");
                setParams.push(ch.policy);
              }
            }
            setParams.push(existingCh[0].id);
            await assistantDbRun(
              `UPDATE contact_channels SET ${setParts.join(", ")} WHERE id = ?`,
              setParams,
            );
          } else {
            // Skip if an address conflict exists on a different contact.
            const conflict = await assistantDbQuery<{ id: string }>(
              "SELECT id FROM contact_channels WHERE type = ? AND address = ?",
              [ch.type, address],
            );
            if (conflict.length) continue;

            await assistantDbRun(
              `INSERT INTO contact_channels
                 (id, contact_id, type, address, is_primary,
                  external_user_id, external_chat_id,
                  status, policy, interaction_count, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
              [
                crypto.randomUUID(),
                contactId,
                ch.type,
                address,
                ch.isPrimary ? 1 : 0,
                ch.externalUserId ?? null,
                ch.externalChatId ?? null,
                ch.status ?? "unverified",
                ch.policy ?? "allow",
                now,
                now,
              ],
            );
          }
        }
      } catch (err) {
        log.warn(
          { contactId, err },
          "upsert_contact: assistant DB dual-write failed (best-effort)",
        );
      }

      // ── Emit contacts_changed ────────────────────────────────────────
      void ipcCallAssistant("emit_event", {
        body: { kind: "contacts_changed" },
      } as unknown as Record<string, unknown>).catch(() => {});

      // ── Build response from assistant DB ─────────────────────────────
      const fullContact = await readAssistantContact(contactId);
      const responseContact = fullContact ?? {
        id: contact.id,
        displayName: contact.displayName,
        role: contact.role,
        principalId: contact.principalId,
        notes: null,
        contactType: (body.contactType as string | undefined) ?? "human",
        userFile: null,
        createdAt: contact.createdAt,
        updatedAt: contact.updatedAt,
        interactionCount: 0,
        lastInteraction: null,
        channels: [],
      };

      log.info({ contactId, created }, "upsert_contact: handled natively");
      return Response.json({ ok: true, contact: responseContact });
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
