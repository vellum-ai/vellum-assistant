/**
 * Gateway proxy endpoints for ingress contacts/invites control-plane routes.
 *
 * These routes are registered as explicit gateway routes for dedicated
 * auth handling rather than falling through to the catch-all proxy.
 */

import { proxyForward } from "@vellumai/assistant-client";

import { mintServiceToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
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

    async handleDeleteContact(
      req: Request,
      contactId: string,
    ): Promise<Response> {
      return forward(req, `/v1/contacts/${contactId}`);
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
