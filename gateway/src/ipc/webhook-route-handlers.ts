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
  registerWebhookIngressRoute,
  unregisterWebhookIngressRoute,
} from "../db/webhook-ingress-route-store.js";
import { isFeatureFlagEnabled } from "../feature-flag-resolver.js";
import { ipcRoute, type IpcRoute } from "./server.js";

const VELAY_WEBHOOKS_FLAG_KEY = "velay-webhooks";

export function createWebhookRouteRoutes(): IpcRoute[] {
  return [
    ipcRoute({
      method: "register_webhook_route",
      schema: RegisterWebhookRouteIpcParamsSchema,
      handler: (params): RegisterWebhookRouteIpcResponse => {
        if (!isFeatureFlagEnabled(VELAY_WEBHOOKS_FLAG_KEY)) {
          return { disabled: true };
        }
        return { disabled: false, route: registerWebhookIngressRoute(params) };
      },
    }),
    ipcRoute({
      method: "unregister_webhook_route",
      schema: UnregisterWebhookRouteIpcParamsSchema,
      handler: (params): UnregisterWebhookRouteIpcResponse => ({
        removed: unregisterWebhookIngressRoute(params.path),
      }),
    }),
    {
      method: "list_webhook_routes",
      handler: (): ListWebhookRoutesIpcResponse => ({
        routes: listWebhookIngressRoutes(),
      }),
    },
  ];
}
