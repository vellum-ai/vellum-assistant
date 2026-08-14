import { AsyncLocalStorage } from "node:async_hooks";

import type { VerifiedPeerOperationContext } from "./verified-peer-context.js";

const ROUTE_HOST_PROCESS_KEY = Symbol.for("vellum.plugin-route-host-process");

export type PluginRoutePrincipalType =
  | "actor"
  | "svc_gateway"
  | "svc_daemon"
  | "local"
  | "assistant_peer";

export interface PluginRouteActorContext {
  readonly principalType: PluginRoutePrincipalType;
  /** Opaque local actor principal ID, or null for non-actor principals. */
  readonly principalId: string | null;
  readonly scopes: readonly string[];
}

export interface PluginRouteHost {
  /** Resolve this plugin's host-owned durable storage directory. */
  getPluginStorageDir(): Promise<string>;
}

export interface PluginRouteContext {
  /** Installed plugin directory ID, derived by the host from the route path. */
  readonly pluginId: string;
  readonly actor: PluginRouteActorContext;
  /** Host-minted correlation ID for this route invocation. */
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly verifiedPeer: VerifiedPeerOperationContext | null;
  readonly host: PluginRouteHost;
}

const routeContextStorage = new AsyncLocalStorage<PluginRouteContext>();

/** Return the active plugin route context, if called from a route handler. */
export function getPluginRouteContext(): PluginRouteContext | undefined {
  return routeContextStorage.getStore();
}

/** Return the active plugin route context or fail outside route execution. */
export function requirePluginRouteContext(): PluginRouteContext {
  const context = getPluginRouteContext();
  if (!context) {
    throw new Error("plugin route context is unavailable");
  }
  return context;
}

/** @internal Mark this process as the isolated plugin route host. */
export function markCurrentProcessAsPluginRouteHost(): void {
  (globalThis as Record<symbol, unknown>)[ROUTE_HOST_PROCESS_KEY] = true;
}

/** @internal Reject main-process-only APIs inside the plugin route host. */
export function assertNotPluginRouteHost(operation: string): void {
  if (
    (globalThis as Record<symbol, unknown>)[ROUTE_HOST_PROCESS_KEY] === true
  ) {
    throw new Error(`${operation} is unavailable in the plugin route host`);
  }
}

/** @internal Establish host-owned context around one plugin route call. */
export function runInPluginRouteContext<T>(
  context: PluginRouteContext,
  fn: () => T,
): T {
  return routeContextStorage.run(context, fn);
}
