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
 * repairs nothing while looking like a repair. Rotation is still withheld
 * when the gateway is merely unreachable: rotating without being able to
 * store the replacement would retire a key the assistant still needs.
 */
export async function resolveAssistantApiKeyForInjection(
  args: ResolveAssistantApiKeyArgs,
): Promise<ResolvedAssistantApiKey> {
  if (args.registrationApiKey) {
    return { apiKey: args.registrationApiKey, source: "registration" };
  }

  const cached = await readGatewayCredential(
    args.runtimeUrl,
    "vellum:assistant_api_key",
    args.bearerToken,
  );

  // Only worth asking when there is a key to ask about: with none stored the
  // answer changes nothing, and a first login would pay for the round trip
  // every time.
  if (cached.value) {
    const status = await verifyGatewayManagedCredential(
      args.runtimeUrl,
      args.bearerToken,
    );
    if (status !== "rejected") {
      return { apiKey: cached.value, source: "stored" };
    }
  }
  if (cached.unreachable) {
    return { apiKey: null, source: "unavailable" };
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
