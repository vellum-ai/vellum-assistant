/**
 * Register and tear down client subscribers on an assistant event hub.
 *
 * The caller supplies the hub, so this helper holds no runtime import into
 * `src/` and stays safe for the test preload's import graph.
 */
import type { HostProxyCapability, InterfaceId } from "../../channels/types.js";
import type {
  AssistantEventHub,
  DesktopPresenceState,
} from "../../runtime/assistant-event-hub.js";

export interface RegisterHubClientArgs {
  hub: AssistantEventHub;
  clientId: string;
  interfaceId?: InterfaceId;
  capabilities?: HostProxyCapability[];
  actorPrincipalId?: string;
  /** Reported immediately after subscribing, when supplied. */
  presence?: DesktopPresenceState;
}

export function registerHubClient(args: RegisterHubClientArgs): void {
  const { hub } = args;
  hub.subscribe({
    type: "client",
    clientId: args.clientId,
    interfaceId: args.interfaceId ?? "macos",
    capabilities: args.capabilities ?? [],
    actorPrincipalId: args.actorPrincipalId,
    callback: () => {},
  });
  if (args.presence) {
    hub.setClientPresence(args.clientId, args.presence);
  }
}

export function clearHubClients(hub: AssistantEventHub): void {
  for (const client of hub.listClients()) {
    hub.disposeClient(client.clientId);
  }
}
