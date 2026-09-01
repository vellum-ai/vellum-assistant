/**
 * Resolve which assistant API key to inject into a running assistant.
 *
 * Shared by the flows that hand a local assistant its platform credentials
 * (`login` and `teleport`). They had the same three-step resolution written
 * out twice, which is exactly the shape that drifts: a fix applied to one is
 * invisible in the other.
 */
import {
  readGatewayAssistantApiKeyStatus,
  readGatewayCredential,
  reprovisionAssistantApiKey,
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
  const status = await readGatewayAssistantApiKeyStatus(
    args.runtimeUrl,
    args.bearerToken,
  );

  if (cached.value && status !== "rejected") {
    return { apiKey: cached.value, source: "stored" };
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
