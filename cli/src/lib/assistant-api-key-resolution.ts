/**
 * Resolve which assistant API key to inject into a running assistant.
 *
 * The one place that decides, for every flow that hands a local assistant its
 * platform credentials (`login`, `teleport`). Keeping the decision here means a
 * rule about which stored key is usable holds in all of them at once.
 */
import {
  readGatewayCredential,
  reprovisionAssistantApiKey,
  verifyGatewayManagedCredential,
} from "./platform-client.js";

/** Where the key came from, so callers can report what they did. */
export type AssistantApiKeySource =
  | "registration"
  | "stored"
  | "reprovisioned"
  | "unavailable";

export interface ResolveAssistantApiKeyArgs {
  /** Key the registration returned, set only when it had none before. */
  registrationApiKey: string | null;
  runtimeUrl: string;
  bearerToken?: string;
  token: string;
  organizationId: string;
  clientInstallationId: string;
  runtimeAssistantId: string;
  clientPlatform: string;
}

export interface ResolvedAssistantApiKey {
  apiKey: string | null;
  source: AssistantApiKeySource;
}

/**
 * Three steps, in order: the key the registration just issued, the key the
 * assistant already holds, then a rotation.
 *
 * A stored key the platform has rejected is skipped, because reinjecting it
 * repairs nothing while looking like a repair. The verdict is asked for
 * before the key is read, so the key returned is one the verdict covers: a
 * repair that lands between the two requests is then read, not overwritten
 * by the value it replaced. Rotation is still withheld when the gateway is
 * merely unreachable: rotating without being able to store the replacement
 * would start the platform's grace clock on a key the assistant still needs,
 * with nothing to hand it in exchange.
 */
export async function resolveAssistantApiKeyForInjection(
  args: ResolveAssistantApiKeyArgs,
): Promise<ResolvedAssistantApiKey> {
  if (args.registrationApiKey) {
    return { apiKey: args.registrationApiKey, source: "registration" };
  }

  const status = await verifyGatewayManagedCredential(
    args.runtimeUrl,
    args.bearerToken,
  );
  // A settled rejection came from a gateway that answered, so the
  // replacement can be stored; the rejected key is not worth reading.
  if (status !== "rejected") {
    const cached = await readGatewayCredential(
      args.runtimeUrl,
      "vellum:assistant_api_key",
      args.bearerToken,
    );
    if (cached.value) {
      return { apiKey: cached.value, source: "stored" };
    }
    if (cached.unreachable) {
      return { apiKey: null, source: "unavailable" };
    }
  }

  const reprovision = await reprovisionAssistantApiKey(
    args.token,
    args.organizationId,
    args.clientInstallationId,
    args.runtimeAssistantId,
    args.clientPlatform,
  );
  return {
    apiKey: reprovision.provisioning.assistant_api_key,
    source: "reprovisioned",
  };
}
