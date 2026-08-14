import { AsyncLocalStorage } from "node:async_hooks";

import { z } from "zod";

const PluginStorageDirBrokerRequestSchema = z
  .object({
    operation: z.literal("plugin.storage-dir"),
  })
  .strict();

export const RouteHostBrokerRequestSchema = z.union([
  PluginStorageDirBrokerRequestSchema,
]);

export type RouteHostBrokerRequest = z.infer<
  typeof RouteHostBrokerRequestSchema
>;

export type RouteHostBrokerResult = {
  readonly operation: "plugin.storage-dir";
  readonly pluginStorageDir: string;
};

export interface RouteHostBrokerContext {
  readonly pluginId: string;
  readonly pluginStorageDir: string;
}

type RouteHostBrokerTransport = (
  request: RouteHostBrokerRequest,
) => Promise<RouteHostBrokerResult>;

const transportStorage = new AsyncLocalStorage<RouteHostBrokerTransport>();

/** Dispatch a broker request in the main assistant process. */
export async function dispatchRouteHostBrokerRequest(
  value: unknown,
  context: RouteHostBrokerContext,
): Promise<RouteHostBrokerResult> {
  const request = RouteHostBrokerRequestSchema.parse(value);
  switch (request.operation) {
    case "plugin.storage-dir":
      return {
        operation: request.operation,
        pluginStorageDir: context.pluginStorageDir,
      };
  }
}

/** @internal Install the authenticated local IPC transport for one route call. */
export function runWithRouteHostBroker<T>(
  transport: RouteHostBrokerTransport,
  fn: () => T,
): T {
  return transportStorage.run(transport, fn);
}

/** @internal Call the main-process broker from a route-host plugin API. */
export function callRouteHostBroker(
  request: RouteHostBrokerRequest,
): Promise<RouteHostBrokerResult> {
  const transport = transportStorage.getStore();
  if (!transport) {
    throw new Error("route host broker is unavailable");
  }
  return transport(request);
}
