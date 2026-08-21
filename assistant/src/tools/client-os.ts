import {
  type ClientOs,
  type HostProxyCapability,
  type InterfaceId,
  parseClientOs,
  supportsHostProxy,
} from "../channels/types.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";

interface HostClientContext {
  clientOs?: ClientOs;
  transportInterface?: InterfaceId;
  sourceActorPrincipalId?: string;
}

export function supportsClientOs(
  supportedClientOs: readonly ClientOs[] | undefined,
  clientOs: ClientOs | undefined,
): boolean {
  return (
    clientOs === undefined ||
    supportedClientOs === undefined ||
    supportedClientOs.includes(clientOs)
  );
}

export function getSkillToolHostCapability(
  toolName: string,
): HostProxyCapability | undefined {
  if (toolName.startsWith("computer_use_")) {
    return "host_cu";
  }
  if (toolName.startsWith("app_control_")) {
    return "host_app_control";
  }
  return undefined;
}

export function getEligibleHostClientOs(
  capability: HostProxyCapability,
  context: HostClientContext,
): Set<ClientOs> {
  const eligible = new Set<ClientOs>();
  const sourceClientOs =
    context.transportInterface === "macos" ||
    context.transportInterface === "windows"
      ? context.transportInterface
      : context.clientOs;
  if (
    sourceClientOs !== undefined &&
    context.transportInterface !== undefined &&
    supportsHostProxy(context.transportInterface, capability)
  ) {
    eligible.add(sourceClientOs);
  }

  if (context.sourceActorPrincipalId !== undefined) {
    for (const client of assistantEventHub.listClientsByCapability(
      capability,
    )) {
      if (client.actorPrincipalId !== context.sourceActorPrincipalId) {
        continue;
      }
      const clientOs = parseClientOs(client.interfaceId);
      if (clientOs !== null) {
        eligible.add(clientOs);
      }
    }
  }
  return eligible;
}

export function supportsClientOsForSkillTool(
  supportedClientOs: readonly ClientOs[] | undefined,
  toolName: string,
  context: HostClientContext,
): boolean {
  if (supportedClientOs === undefined) {
    return true;
  }
  const capability = getSkillToolHostCapability(toolName);
  if (capability === undefined) {
    return supportsClientOs(supportedClientOs, context.clientOs);
  }
  const eligible = getEligibleHostClientOs(capability, context);
  if (eligible.size === 0) {
    return supportsClientOs(supportedClientOs, context.clientOs);
  }
  for (const clientOs of eligible) {
    if (supportedClientOs.includes(clientOs)) {
      return true;
    }
  }
  return false;
}

export function resolveInvocationHostClientOs(
  capability: HostProxyCapability,
  input: Record<string, unknown>,
  context: HostClientContext,
): ClientOs | undefined {
  const targetClientId =
    typeof input.target_client_id === "string" && input.target_client_id !== ""
      ? input.target_client_id
      : undefined;
  if (targetClientId !== undefined) {
    const client = assistantEventHub.getClientById(targetClientId);
    return client?.capabilities.includes(capability)
      ? (parseClientOs(client.interfaceId) ?? undefined)
      : undefined;
  }

  const eligible = getEligibleHostClientOs(capability, context);
  return eligible.size === 1 ? eligible.values().next().value : undefined;
}
