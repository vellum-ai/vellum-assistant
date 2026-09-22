/**
 * IPC route definitions for the webhook ingress route registry.
 *
 * Lets the daemon claim, drop, and inspect the exact subpaths this assistant
 * answers from outside. Only registration is gated on `velay-webhooks`;
 * revocation and inspection stay available so an operator can always see and
 * remove what was claimed while the flag was on.
 *
 * The request and response shapes are the shared contract in
 * `@vellumai/gateway-client`, which the daemon reads the other end of.
 */

import {
  type ListWebhookRoutesIpcResponse,
  RegisterWebhookRouteIpcParamsSchema,
  type RegisterWebhookRouteIpcResponse,
  UnregisterWebhookRouteIpcParamsSchema,
  type UnregisterWebhookRouteIpcResponse,
} from "@vellumai/gateway-client/gateway-ipc-contracts";

import {
  listWebhookIngressRoutes,
  PLUGIN_WEBHOOK_ROUTE_TYPE,
  registerWebhookIngressRoute,
  unregisterWebhookIngressRoute,
} from "../db/webhook-ingress-route-store.js";
import { markPluginWebhookRoutesDirty } from "../channels/plugin-webhook-route-sync.js";
import { PLUGIN_WEBHOOK_PATH_PREFIX } from "../velay/path-utils.js";
import { isFeatureFlagEnabled } from "../feature-flag-resolver.js";
import { ipcRoute, type IpcRoute } from "./server.js";

/**
 * The contract carries `type` as free text, so the caller is told here that
 * one value is not theirs to claim: rows of that type belong to the plugin
 * ingress reconcile, which removes any it does not currently serve.
 *
 * `code` is the property `buildErrorResponse` mirrors into the wire
 * `errorCode` for IPC clients.
 */
function assertUnreservedRouteType(type: string): void {
  if (type === PLUGIN_WEBHOOK_ROUTE_TYPE) {
    throw Object.assign(
      new Error(
        `Webhook route type "${PLUGIN_WEBHOOK_ROUTE_TYPE}" is reserved for plugin declarations`,
      ),
      { statusCode: 400, code: "reserved_webhook_route_type" },
    );
  }
}

export function createWebhookRouteRoutes(): IpcRoute[] {
  return [
    ipcRoute({
      method: "register_webhook_route",
      schema: RegisterWebhookRouteIpcParamsSchema,
      handler: (params): RegisterWebhookRouteIpcResponse => {
        if (!isFeatureFlagEnabled("velay-webhooks")) {
          return { disabled: true };
        }
        assertUnreservedRouteType(params.type);
        return { disabled: false, route: registerWebhookIngressRoute(params) };
      },
    }),
    ipcRoute({
      method: "unregister_webhook_route",
      schema: UnregisterWebhookRouteIpcParamsSchema,
      handler: (params): UnregisterWebhookRouteIpcResponse => {
        const removed = unregisterWebhookIngressRoute(params.path);
        // A removed row inside the plugin namespace may have been the only
        // entry admitting a still-servable plugin route, so the reconcile
        // poll is asked to settle the namespace again.
        if (removed && params.path.startsWith(PLUGIN_WEBHOOK_PATH_PREFIX)) {
          markPluginWebhookRoutesDirty();
        }
        return { removed };
      },
    }),
    {
      method: "list_webhook_routes",
      handler: (): ListWebhookRoutesIpcResponse => ({
        routes: listWebhookIngressRoutes(),
      }),
    },
  ];
}
