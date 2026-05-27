import { client } from "@/generated/api/client.gen";
import { PROVIDER_DISPLAY_NAMES as CATALOG_PROVIDER_DISPLAY_NAMES } from "@/assistant/llm-model-catalog";

// ---------------------------------------------------------------------------
// Types — mirror the assistant daemon's inference/auth.ts shapes.
// ---------------------------------------------------------------------------

export type ConnectionProvider =
  | "anthropic"
  | "openai"
  | "gemini"
  | "ollama"
  | "fireworks"
  | "openrouter"
  | "openai-compatible";

export type ConnectionStatus = "active" | "disabled";

export interface ConnectionModel {
  id: string;
  displayName?: string;
}

export type Auth =
  | { type: "api_key"; credential: string }
  | { type: "oauth_subscription"; credential: string }
  | { type: "platform" }
  | { type: "none" };

export interface ProviderConnection {
  name: string;
  provider: ConnectionProvider;
  auth: Auth;
  status: ConnectionStatus;
  label: string | null;
  createdAt: number;
  updatedAt: number;
  baseUrl: string | null;
  models: ConnectionModel[] | null;
  isManaged?: boolean;
}

export interface CreateConnectionInput {
  name: string;
  provider: ConnectionProvider;
  auth: Auth;
  label?: string | null;
  status?: ConnectionStatus;
  base_url?: string | null;
  models?: ConnectionModel[] | null;
}

export interface UpdateConnectionInput {
  auth: Auth;
  label?: string | null;
  status?: ConnectionStatus;
  base_url?: string | null;
  models?: ConnectionModel[] | null;
}

function buildConnectionProviderDisplayNames(): Record<
  ConnectionProvider,
  string
> {
  const lookup = {
    anthropic: CATALOG_PROVIDER_DISPLAY_NAMES.anthropic,
    openai: CATALOG_PROVIDER_DISPLAY_NAMES.openai,
    gemini: CATALOG_PROVIDER_DISPLAY_NAMES.gemini,
    ollama: CATALOG_PROVIDER_DISPLAY_NAMES.ollama,
    fireworks: CATALOG_PROVIDER_DISPLAY_NAMES.fireworks,
    openrouter: CATALOG_PROVIDER_DISPLAY_NAMES.openrouter,
    "openai-compatible":
      CATALOG_PROVIDER_DISPLAY_NAMES["openai-compatible"],
  } satisfies Record<ConnectionProvider, string | undefined>;
  const out = {} as Record<ConnectionProvider, string>;
  for (const provider of Object.keys(lookup) as ConnectionProvider[]) {
    const label = lookup[provider];
    if (label === undefined) {
      throw new Error(
        `provider-connections-client: catalog missing displayName for ` +
          `ConnectionProvider "${provider}".`,
      );
    }
    out[provider] = label;
  }
  return out;
}

export const PROVIDER_DISPLAY_NAMES: Record<ConnectionProvider, string> =
  buildConnectionProviderDisplayNames();

// ---------------------------------------------------------------------------
// Client wrappers — hit the daemon's /v1/inference/provider-connections routes
// ---------------------------------------------------------------------------

function throwHttpError(response: Response | undefined): never {
  throw Object.assign(new Error("Request failed"), { status: response?.status });
}

function normalizeConnection(raw: Record<string, unknown>): ProviderConnection {
  return {
    ...(raw as Omit<ProviderConnection, "status" | "label" | "baseUrl" | "models">),
    status: (raw.status as ConnectionStatus | undefined) ?? "active",
    label: (raw.label as string | null | undefined) ?? null,
    baseUrl: (raw.baseUrl as string | null | undefined) ?? null,
    models: (raw.models as ConnectionModel[] | null | undefined) ?? null,
  };
}

export async function listConnections(
  assistantId: string,
  provider?: ConnectionProvider,
): Promise<ProviderConnection[]> {
  const result = await client.get({
    url: `/v1/assistants/{assistant_id}/inference/provider-connections`,
    path: { assistant_id: assistantId },
    query: provider ? { provider } : undefined,
  });
  if (!result.response?.ok) throwHttpError(result.response);
  const raw = (result.data as { connections: Record<string, unknown>[] }).connections ?? [];
  return raw.map(normalizeConnection);
}

export async function createConnection(
  assistantId: string,
  input: CreateConnectionInput,
): Promise<ProviderConnection> {
  const result = await client.post({
    url: `/v1/assistants/{assistant_id}/inference/provider-connections`,
    path: { assistant_id: assistantId },
    body: input,
    headers: { "Content-Type": "application/json" },
  });
  if (!result.response?.ok) throwHttpError(result.response);
  return normalizeConnection(result.data as Record<string, unknown>);
}

export async function updateConnection(
  assistantId: string,
  name: string,
  input: UpdateConnectionInput,
): Promise<ProviderConnection> {
  const result = await client.patch({
    url: `/v1/assistants/{assistant_id}/inference/provider-connections/{name}`,
    path: { assistant_id: assistantId, name },
    body: input,
    headers: { "Content-Type": "application/json" },
  });
  if (!result.response?.ok) throwHttpError(result.response);
  return normalizeConnection(result.data as Record<string, unknown>);
}

export async function deleteConnection(
  assistantId: string,
  name: string,
): Promise<void> {
  const result = await client.delete({
    url: `/v1/assistants/{assistant_id}/inference/provider-connections/{name}`,
    path: { assistant_id: assistantId, name },
  });
  if (!result.response?.ok) throwHttpError(result.response);
}

// ---------------------------------------------------------------------------
// Secrets API
// ---------------------------------------------------------------------------

export interface CredentialEntry {
  service: string;
  field: string;
}

export interface ReadSecretResult {
  found: boolean;
  masked: string | null;
}

export async function listCredentials(
  assistantId: string,
): Promise<CredentialEntry[]> {
  const result = await client.get({
    url: `/v1/assistants/{assistant_id}/secrets/`,
    path: { assistant_id: assistantId },
  });
  if (!result.response?.ok) throwHttpError(result.response);
  const body = result.data as {
    secrets?: Array<Record<string, unknown>>;
    accounts?: Array<Record<string, unknown>>;
  };
  const entries = body.secrets ?? body.accounts ?? [];
  const results: CredentialEntry[] = [];
  for (const entry of entries) {
    const type = entry["type"] as string | undefined;
    if (!type) continue;
    if (type === "api_key") {
      const entryName = entry["name"] as string | undefined;
      if (entryName) results.push({ service: entryName, field: "api_key" });
    } else if (type === "credential") {
      const entryName = entry["name"] as string | undefined;
      if (!entryName) continue;
      const colonIdx = entryName.lastIndexOf(":");
      if (colonIdx >= 0) {
        const service = entryName.slice(0, colonIdx);
        const field = entryName.slice(colonIdx + 1);
        if (service && field) results.push({ service, field });
      }
    }
  }
  return results;
}

export async function readSecret(
  assistantId: string,
  type: "credential" | "api_key",
  name: string,
): Promise<ReadSecretResult> {
  const result = await client.post({
    url: `/v1/assistants/{assistant_id}/secrets/read/`,
    path: { assistant_id: assistantId },
    body: { type, name },
    headers: { "Content-Type": "application/json" },
  });
  if (!result.response?.ok) return { found: false, masked: null };
  const body = result.data as { found?: boolean; masked?: string | null };
  return { found: body.found ?? false, masked: body.masked ?? null };
}

export async function writeSecret(
  assistantId: string,
  type: "credential" | "api_key",
  name: string,
  value: string,
): Promise<void> {
  const result = await client.post({
    url: `/v1/assistants/{assistant_id}/secrets/`,
    path: { assistant_id: assistantId },
    body: { type, name, value },
    headers: { "Content-Type": "application/json" },
  });
  if (!result.response?.ok) throwHttpError(result.response);
}

// ---------------------------------------------------------------------------
// ChatGPT Subscription OAuth — manual copy-paste flow
// ---------------------------------------------------------------------------

export interface ChatgptAuthStartResult {
  authorize_url: string;
  state: string;
}

export async function startChatgptSubscriptionAuth(
  assistantId: string,
): Promise<ChatgptAuthStartResult> {
  const result = await client.post({
    url: `/v1/assistants/{assistant_id}/inference/chatgpt-subscription/auth`,
    path: { assistant_id: assistantId },
    headers: { "Content-Type": "application/json" },
  });
  if (!result.response?.ok) throwHttpError(result.response);
  return result.data as ChatgptAuthStartResult;
}

export async function exchangeChatgptAuthCode(
  assistantId: string,
  code: string,
  state: string,
): Promise<void> {
  const result = await client.post({
    url: `/v1/assistants/{assistant_id}/inference/chatgpt-subscription/auth/exchange`,
    path: { assistant_id: assistantId },
    body: { code, state },
    headers: { "Content-Type": "application/json" },
  });
  if (!result.response?.ok) throwHttpError(result.response);
}
