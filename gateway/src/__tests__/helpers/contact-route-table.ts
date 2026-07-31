/**
 * Builds the REAL contact-family route table (`buildContactsControlPlaneRoutes`,
 * the same builder index.ts spreads) with marker handlers, so suites can pin
 * route matching and auth/scope against production registrations. The handler
 * bindings are closures, so a route is identified by invoking its handler and
 * reading the `{ marker }` body. No import-time side effects.
 */
import type { RouteDefinition } from "../../http/router.js";
import {
  buildContactsControlPlaneRoutes,
  type ContactsControlPlaneProxy,
} from "../../http/routes/contacts-control-plane-route-table.js";

const marker = (name: string) => async () => Response.json({ marker: name });

export function buildMarkedContactRoutes(): RouteDefinition[] {
  const contactsControlPlaneProxy: ContactsControlPlaneProxy = {
    handleListContacts: marker("handleListContacts"),
    handleUpsertContact: marker("handleUpsertContact"),
    handleGetContact: marker("handleGetContact"),
    handleDeleteContact: marker("handleDeleteContact"),
    handleMergeContacts: marker("handleMergeContacts"),
    handleUpdateContactChannel: marker("handleUpdateContactChannel"),
    handleVerifyContactChannel: marker("handleVerifyContactChannel"),
    handleListInvites: marker("handleListInvites"),
    handleCreateInvite: marker("handleCreateInvite"),
    handleRedeemInvite: marker("handleRedeemInvite"),
    handleCallInvite: marker("handleCallInvite"),
    handleRevokeInvite: marker("handleRevokeInvite"),
  };
  return buildContactsControlPlaneRoutes({
    contactsControlPlaneProxy,
    handleContactPromptSubmit: marker("handleContactPromptSubmit"),
  });
}

/** Resolves which proxy binding a marked route's handler is bound to. */
export async function markedHandlerName(
  route: RouteDefinition,
): Promise<string> {
  const res = await route.handler(
    new Request("http://gateway.local/"),
    ["p0"],
    () => "127.0.0.1",
    () => "127.0.0.1",
  );
  return ((await res.json()) as { marker: string }).marker;
}
