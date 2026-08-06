/**
 * Contact-family HTTP route table (flat paths only).
 *
 * Single source of truth for the contacts/contact-channels registrations in
 * `index.ts` — the fall-through regression test builds its router from this
 * same table, so the tested routes cannot drift from production.
 *
 * Registration ORDER is load-bearing: the invites routes must precede the
 * `/v1/contacts/:id` catch-alls so `DELETE /v1/contacts/invites/:id` revokes
 * an invite instead of deleting a contact named "invites".
 */

import type { RouteDefinition } from "../router.js";
import type { handleContactPromptSubmit } from "./contact-prompt.js";
import type { createContactsControlPlaneProxyHandler } from "./contacts-control-plane-proxy.js";

export type ContactsControlPlaneProxy = ReturnType<
  typeof createContactsControlPlaneProxyHandler
>;

export interface ContactsControlPlaneRouteDeps {
  contactsControlPlaneProxy: ContactsControlPlaneProxy;
  handleContactPromptSubmit: typeof handleContactPromptSubmit;
}

export function buildContactsControlPlaneRoutes({
  contactsControlPlaneProxy,
  handleContactPromptSubmit,
}: ContactsControlPlaneRouteDeps): RouteDefinition[] {
  return [
    {
      path: "/v1/contacts/prompt/submit",
      method: "POST",
      auth: "edge",
      handler: (req) => handleContactPromptSubmit(req),
    },
    {
      path: "/v1/contacts",
      method: "GET",
      auth: "edge",
      handler: (req) => contactsControlPlaneProxy.handleListContacts(req),
    },
    {
      path: "/v1/contacts",
      method: "POST",
      auth: "edge",
      handler: (req) => contactsControlPlaneProxy.handleUpsertContact(req),
    },
    {
      path: "/v1/contacts/merge",
      method: "POST",
      auth: "edge",
      handler: (req) => contactsControlPlaneProxy.handleMergeContacts(req),
    },
    {
      path: /^\/v1\/contact-channels\/([^/]+)$/,
      method: "PATCH",
      auth: "edge",
      handler: (req, params) =>
        contactsControlPlaneProxy.handleUpdateContactChannel(req, params[0]),
    },
    {
      path: /^\/v1\/contact-channels\/([^/]+)\/verify$/,
      method: "POST",
      auth: "edge-guardian",
      handler: (req, params) =>
        contactsControlPlaneProxy.handleVerifyContactChannel(req, params[0]),
    },
    // ── Contacts/invites control plane ──
    // Scope map: invites list → settings.read; create/redeem/revoke/call →
    // settings.write.
    {
      path: "/v1/contacts/invites",
      method: "GET",
      auth: "edge-scoped",
      scope: "settings.read",
      handler: (req) => contactsControlPlaneProxy.handleListInvites(req),
    },
    {
      path: "/v1/contacts/invites",
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req) => contactsControlPlaneProxy.handleCreateInvite(req),
    },
    {
      path: "/v1/contacts/invites/redeem",
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req) => contactsControlPlaneProxy.handleRedeemInvite(req),
    },
    {
      path: /^\/v1\/contacts\/invites\/([^/]+)\/call$/,
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req, params) =>
        contactsControlPlaneProxy.handleCallInvite(req, params[0]),
    },
    {
      path: /^\/v1\/contacts\/invites\/([^/]+)$/,
      method: "DELETE",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: (req, params) =>
        contactsControlPlaneProxy.handleRevokeInvite(req, params[0]),
    },
    {
      // Keep DELETE on the invite collection unsupported; only /invites/:id
      // should revoke an invite.
      path: /^\/v1\/contacts\/(?!invites\/?$)([^/]+)\/?$/,
      method: "DELETE",
      auth: "edge",
      handler: (_req, params) =>
        contactsControlPlaneProxy.handleDeleteContact(params[0]),
    },
    {
      path: /^\/v1\/contacts\/([^/]+)$/,
      method: "GET",
      auth: "edge",
      handler: (req, params) =>
        contactsControlPlaneProxy.handleGetContact(req, params[0]),
    },
  ];
}
