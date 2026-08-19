/**
 * IPC route definitions for the webhook ingress route registry.
 *
 * Lets the daemon claim, drop, and inspect the exact subpaths this assistant
 * answers from outside. Only registration is gated on `velay-webhooks`;
 * revocation and inspection stay available so an operator can always see and
 * remove what was claimed while the flag was on.
 */

import { z } from "zod";

import {
  listWebhookIngressRoutes,
  registerWebhookIngressRoute,
  unregisterWebhookIngressRoute,
  type WebhookIngressRoute,
} from "../db/webhook-ingress-route-store.js";
import { isFeatureFlagEnabled } from "../feature-flag-resolver.js";
import { ipcRoute, type IpcRoute } from "./server.js";

const VELAY_WEBHOOKS_FLAG_KEY = "velay-webhooks";

const RegisterWebhookRouteSchema = z.object({
  path: z.string().min(1),
  type: z.string().min(1),
  source: z.string().nullish(),
});

const UnregisterWebhookRouteSchema = z.object({
  path: z.string().min(1),
});

/**
 * A refusal is a normal result rather than an error: the daemon reads
 * `disabled` as "this assistant is not serving its own webhooks" and falls
 * back to the platform's callback routes.
 */
type RegisterWebhookRouteResult =
  | { disabled: true }
  | { disabled: false; route: WebhookIngressRoute };

export function createWebhookRouteRoutes(): IpcRoute[] {
  return [
    ipcRoute({
      method: "register_webhook_route",
      schema: RegisterWebhookRouteSchema,
      handler: (params): RegisterWebhookRouteResult => {
        if (!isFeatureFlagEnabled(VELAY_WEBHOOKS_FLAG_KEY)) {
          return { disabled: true };
        }
        return { disabled: false, route: registerWebhookIngressRoute(params) };
      },
    }),
    ipcRoute({
      method: "unregister_webhook_route",
      schema: UnregisterWebhookRouteSchema,
      handler: (params) => ({
        removed: unregisterWebhookIngressRoute(params.path),
      }),
    }),
    {
      method: "list_webhook_routes",
      handler: () => ({ routes: listWebhookIngressRoutes() }),
    },
  ];
}
