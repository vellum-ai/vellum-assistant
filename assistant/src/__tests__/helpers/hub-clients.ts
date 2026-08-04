/**
 * Register and tear down client subscribers on an assistant event hub.
 *
 * Defaults to the process singleton, which is what route and policy tests
 * exercise. Pass `hub` to drive a standalone instance instead.
 */
import type { HostProxyCapability, InterfaceId } from "../../channels/types.js";
import type {
  AssistantEventHub,
  DesktopPresenceState,
} from "../../runtime/assistant-event-hub.js";
import { assistantEventHub } from "../../runtime/assistant-event-hub.js";

export interface RegisterHubClientArgs {
  clientId: string;
  hub?: AssistantEventHub;
  interfaceId?: InterfaceId;
  capabilities?: HostProxyCapability[];
  actorPrincipalId?: string;
  /** Reported immediately after subscribing, when supplied. */
  presence?: DesktopPresenceState;
}

export function registerHubClient(args: RegisterHubClientArgs): void {
  const hub = args.hub ?? assistantEventHub;
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

export function clearHubClients(
  hub: AssistantEventHub = assistantEventHub,
): void {
  for (const client of hub.listClients()) {
    hub.disposeClient(client.clientId);
  }
}
