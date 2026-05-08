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

    async handleUpsertContact(req: Request): Promise<Response> {
      return forward(req, "/v1/contacts");
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
      } as unknown as Record<string, unknown>);
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
     * Gateway-native: the channel mutation happens entirely in the gateway
     * DB. We do **not** forward to the assistant runtime and we do **not**
     * touch the assistant DB. The auth layer (`edge-guardian` strategy)
     * has already proven the caller is the bound guardian.
     *
     * Idempotent: a row that's already active+verifiedVia=manual returns
     * the same shape (200 with channel) but no second write occurs.
     */
    handleVerifyContactChannel(
      _req: Request,
      contactChannelId: string,
    ): Response {
      const result = new ContactStore().markChannelVerified(contactChannelId);
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
