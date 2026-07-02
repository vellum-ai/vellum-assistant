import { buildVellumMutatingHeaders } from "@/lib/auth/request-headers";
import {
  getActiveAssistant,
  getLocalGatewayUrl,
  getPlatformRuntimeUrl,
  getSelectedAssistant,
  isLocalAssistant,
  isLocalMode,
  isPlatformDisabled,
  isRemoteGatewayMode,
  primeLocalGatewayConnectionWithRepair,
  updateLockfileAssistant,
  type LockfileAssistant,
} from "@/lib/local-mode";
import {
  getSelfHostedActorToken,
  getSelfHostedIngressUrl,
} from "@/lib/self-hosted/connection";
import { getDeviceId } from "@/runtime/device-id";
import { isElectron } from "@/runtime/is-electron";
import { getElectronSessionToken } from "@/runtime/session-token";
import {
  getActiveOrganizationIdForRequests,
  useOrganizationStore,
} from "@/stores/organization-store";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ELECTRON_RENDERER_ORIGIN_HEADER = "X-Vellum-Electron-Renderer-Origin";

type PlatformStatusBody = {
  assistantId?: unknown;
  assistant_id?: unknown;
  baseUrl?: unknown;
  base_url?: unknown;
  organizationId?: unknown;
  organization_id?: unknown;
  hasAssistantApiKey?: unknown;
  has_assistant_api_key?: unknown;
  clientInstallationId?: unknown;
  client_installation_id?: unknown;
};

type LocalPlatformStatus = {
  assistantId: string | null;
  baseUrl: string | null;
  organizationId: string | null;
  hasAssistantApiKey: boolean | null;
  clientInstallationId: string | null;
};

type EnsureRegistrationResponse = {
  id?: unknown;
  assistant_id?: unknown;
  assistant?: {
    id?: unknown;
    name?: unknown;
  };
  assistant_api_key?: unknown;
  webhook_secret?: unknown;
};

type ReprovisionApiKeyResponse = {
  provisioning?: {
    assistant_api_key?: unknown;
  };
};

type BootstrapLocalAssistantPlatformIdentityOptions = {
  allowGatewayRepair?: boolean;
  onError?: (error: unknown) => void;
};

type ResolveLocalAssistantPlatformIdentityOptions = {
  allowGatewayRepair?: boolean;
};

const platformAssistantIdCache = new Map<string, Promise<string>>();

export function resetLocalPlatformIdentityCacheForTesting(): void {
  platformAssistantIdCache.clear();
}

export async function resolveLocalAssistantPlatformIdentity(
  assistantId: string,
  options: ResolveLocalAssistantPlatformIdentityOptions = {},
): Promise<string> {
  if (
    !isLocalMode() ||
    isRemoteGatewayMode() ||
    isPlatformDisabled() ||
    isUuid(assistantId)
  ) {
    return assistantId;
  }

  const assistant = resolveLocalAssistant(assistantId);
  if (!assistant) {
    return assistantId;
  }

  const cached = platformAssistantIdCache.get(assistant.assistantId);
  if (cached) return cached;

  const promise = ensureLocalAssistantPlatformIdentity(assistant, {
    allowGatewayRepair: options.allowGatewayRepair ?? true,
  });
  platformAssistantIdCache.set(assistant.assistantId, promise);
  try {
    return await promise;
  } catch (error) {
    platformAssistantIdCache.delete(assistant.assistantId);
    throw error;
  }
}

export function bootstrapLocalAssistantPlatformIdentity(
  assistantId?: string,
  options: BootstrapLocalAssistantPlatformIdentityOptions = {},
): void {
  if (!isLocalMode() || isRemoteGatewayMode() || isPlatformDisabled()) return;

  let targetAssistantId = assistantId;
  if (!targetAssistantId) {
    const assistant = getSelectedAssistant();
    if (!assistant || !isLocalAssistant(assistant)) return;
    targetAssistantId = assistant.assistantId;
  }

  void resolveLocalAssistantPlatformIdentity(targetAssistantId, {
    allowGatewayRepair: options.allowGatewayRepair ?? false,
  }).catch(
    options.onError ??
      ((error: unknown) => {
        console.warn("local assistant platform bootstrap failed", error);
      }),
  );
}

function resolveLocalAssistant(assistantId: string): LockfileAssistant | null {
  const active = getActiveAssistant();
  if (active?.assistantId === assistantId && isLocalAssistant(active)) {
    return active;
  }
  const selected = getSelectedAssistant();
  if (selected?.assistantId === assistantId && isLocalAssistant(selected)) {
    return selected;
  }
  return null;
}

async function ensureLocalAssistantPlatformIdentity(
  assistant: LockfileAssistant,
  options: { allowGatewayRepair: boolean },
): Promise<string> {
  const gateway = await ensureGatewayAccess(assistant, options);
  const status = await fetchPlatformStatus(gateway, assistant.assistantId);
  const statusPlatformAssistantId =
    status?.assistantId && isUuid(status.assistantId)
      ? status.assistantId
      : null;
  if (statusPlatformAssistantId && status?.hasAssistantApiKey !== false) {
    const statusOrganizationId =
      status?.organizationId ?? assistant.platformOrganizationId ?? null;
    if (statusOrganizationId) {
      await persistPlatformRegistrationMetadata(assistant, {
        platformAssistantId: statusPlatformAssistantId,
        platformBaseUrl: status?.baseUrl ?? getPlatformRuntimeUrl(),
        organizationId: statusOrganizationId,
      });
    }
    return statusPlatformAssistantId;
  }

  const organizationId = await resolveOrganizationId(
    status?.organizationId ?? null,
    assistant,
  );
  if (!organizationId) {
    throw new Error(
      "Sign in to Vellum and select an organization to register this local assistant.",
    );
  }

  const clientInstallationId =
    status?.clientInstallationId ?? getDeviceId() ?? null;
  if (!clientInstallationId) {
    throw new Error(
      "Unable to identify this local assistant host for platform registration.",
    );
  }

  const registration = await ensureRegistration(
    assistant,
    organizationId,
    clientInstallationId,
  );
  const registrationPlatformAssistantId = firstString(
    registration.assistant?.id,
    registration.assistant_id,
    registration.id,
  );
  const platformAssistantId =
    statusPlatformAssistantId ?? registrationPlatformAssistantId;
  if (!platformAssistantId || !isUuid(platformAssistantId)) {
    throw new Error(
      "The platform registration response did not include an assistant UUID.",
    );
  }

  let assistantApiKey = stringValue(registration.assistant_api_key);
  if (!assistantApiKey && status?.hasAssistantApiKey !== true) {
    assistantApiKey = await reprovisionApiKey(
      assistant,
      organizationId,
      clientInstallationId,
    );
  }

  const platformBaseUrl = status?.baseUrl ?? getPlatformRuntimeUrl();
  await injectPlatformCredentials(gateway, {
    assistantApiKey,
    platformAssistantId,
    platformBaseUrl,
    organizationId,
    webhookSecret: stringValue(registration.webhook_secret),
  });
  await persistPlatformRegistrationMetadata(assistant, {
    platformAssistantId,
    platformBaseUrl,
    organizationId,
  });

  return platformAssistantId;
}

async function persistPlatformRegistrationMetadata(
  assistant: LockfileAssistant,
  params: {
    platformAssistantId: string;
    platformBaseUrl: string;
    organizationId: string;
  },
): Promise<void> {
  await updateLockfileAssistant({
    ...assistant,
    platformAssistantId: params.platformAssistantId,
    platformBaseUrl: params.platformBaseUrl,
    platformOrganizationId: params.organizationId,
  }).catch((error: unknown) => {
    console.warn("local assistant platform lockfile update failed", error);
  });
}

async function ensureGatewayAccess(
  assistant: LockfileAssistant,
  options: { allowGatewayRepair: boolean },
): Promise<{ gatewayUrl: string; actorToken: string }> {
  let gatewayUrl = getSelfHostedIngressUrl();
  let actorToken = getSelfHostedActorToken();

  if (options.allowGatewayRepair && (!gatewayUrl || !actorToken)) {
    await primeLocalGatewayConnectionWithRepair(assistant);
    gatewayUrl = getSelfHostedIngressUrl();
    actorToken = getSelfHostedActorToken();
  }

  if (!gatewayUrl || !actorToken) {
    const localGateway = getLocalGatewayUrl(assistant);
    if (localGateway) {
      gatewayUrl = `${window.location.origin}${localGateway}`;
    }
  }

  if (!gatewayUrl || !actorToken) {
    throw new Error(
      "Unable to reach the local assistant for platform identity setup.",
    );
  }

  return { gatewayUrl, actorToken };
}

async function fetchPlatformStatus(
  gateway: { gatewayUrl: string; actorToken: string },
  runtimeAssistantId: string,
): Promise<LocalPlatformStatus | null> {
  const url = gatewayUrl(
    gateway.gatewayUrl,
    `/v1/assistants/${encodeURIComponent(runtimeAssistantId)}/platform/status`,
  );
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${gateway.actorToken}`,
    },
    credentials: "omit",
  }).catch(() => null);
  if (!response?.ok) return null;

  const body = (await response
    .json()
    .catch(() => null)) as PlatformStatusBody | null;
  return {
    assistantId: firstString(body?.assistantId, body?.assistant_id),
    baseUrl: firstString(body?.baseUrl, body?.base_url),
    organizationId: firstString(body?.organizationId, body?.organization_id),
    hasAssistantApiKey: firstBoolean(
      body?.hasAssistantApiKey,
      body?.has_assistant_api_key,
    ),
    clientInstallationId: firstString(
      body?.clientInstallationId,
      body?.client_installation_id,
    ),
  };
}

async function resolveOrganizationId(
  statusOrganizationId: string | null,
  assistant: LockfileAssistant,
): Promise<string | null> {
  const existing =
    statusOrganizationId ??
    assistant.platformOrganizationId ??
    getActiveOrganizationIdForRequests() ??
    assistant.organizationId ??
    null;
  if (existing) return existing;

  await useOrganizationStore
    .getState()
    .fetchOrganizations()
    .catch(() => {});
  return (
    getActiveOrganizationIdForRequests() ??
    assistant.platformOrganizationId ??
    assistant.organizationId ??
    null
  );
}

async function ensureRegistration(
  assistant: LockfileAssistant,
  organizationId: string,
  clientInstallationId: string,
): Promise<EnsureRegistrationResponse> {
  const body = await platformPost<EnsureRegistrationResponse>(
    "/v1/assistants/self-hosted-local/ensure-registration/",
    assistant,
    organizationId,
    clientInstallationId,
  );
  return body;
}

async function reprovisionApiKey(
  assistant: LockfileAssistant,
  organizationId: string,
  clientInstallationId: string,
): Promise<string | null> {
  const body = await platformPost<ReprovisionApiKeyResponse>(
    "/v1/assistants/self-hosted-local/reprovision-api-key/",
    assistant,
    organizationId,
    clientInstallationId,
  );
  return stringValue(body.provisioning?.assistant_api_key);
}

async function platformPost<T>(
  path: string,
  assistant: LockfileAssistant,
  organizationId: string,
  clientInstallationId: string,
): Promise<T> {
  const headers = new Headers({
    ...(await buildVellumMutatingHeaders(
      {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      {
        includeSelfHostedActorToken: false,
        organizationId,
      },
    )),
  });

  const sessionToken = getElectronSessionToken();
  if (isElectron()) {
    if (!sessionToken) {
      throw new Error("Sign in to Vellum to register this local assistant.");
    }
    headers.set(
      ELECTRON_RENDERER_ORIGIN_HEADER,
      `${window.location.protocol}//${window.location.host}`,
    );
  }

  const response = await fetch(
    new URL(path, window.location.origin).toString(),
    {
      method: "POST",
      headers,
      credentials: isElectron() ? "omit" : "same-origin",
      body: JSON.stringify({
        client_installation_id: clientInstallationId,
        runtime_assistant_id: assistant.assistantId,
        client_platform: isElectron() ? "macos" : "web",
      }),
    },
  ).catch((error: unknown) => {
    throw new Error(
      `Unable to reach the platform registration endpoint: ${errorMessage(error)}`,
    );
  });

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(
      `Unable to register the local assistant with the platform (HTTP ${response.status})${detail ? `: ${detail}` : "."}`,
    );
  }

  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new Error(
      `Unable to read the platform registration response: ${errorMessage(error)}`,
    );
  }
}

async function injectPlatformCredentials(
  gateway: { gatewayUrl: string; actorToken: string },
  params: {
    assistantApiKey: string | null;
    platformAssistantId: string;
    platformBaseUrl: string;
    organizationId: string;
    webhookSecret: string | null;
  },
): Promise<void> {
  const entries: Array<[string, string | null]> = [
    ["vellum:assistant_api_key", params.assistantApiKey],
    ["vellum:platform_assistant_id", params.platformAssistantId],
    ["vellum:platform_base_url", params.platformBaseUrl],
    ["vellum:platform_organization_id", params.organizationId],
    ["vellum:webhook_secret", params.webhookSecret],
  ];

  await Promise.all(
    entries
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
      .map(([name, value]) => injectCredential(gateway, name, value)),
  );
}

async function injectCredential(
  gateway: { gatewayUrl: string; actorToken: string },
  name: string,
  value: string,
): Promise<boolean> {
  const response = await fetch(gatewayUrl(gateway.gatewayUrl, "/v1/secrets"), {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${gateway.actorToken}`,
      "Content-Type": "application/json",
    },
    credentials: "omit",
    body: JSON.stringify({ type: "credential", name, value }),
  }).catch((error: unknown) => {
    throw new Error(
      `Unable to reach the local assistant while storing ${name}: ${errorMessage(error)}`,
    );
  });
  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(
      `Unable to store ${name} on the local assistant (HTTP ${response.status})${detail ? `: ${detail}` : "."}`,
    );
  }
  return true;
}

async function readErrorDetail(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await response.json().catch(() => null)) as unknown;
    const detail =
      body && typeof body === "object" && "detail" in body
        ? stringValue((body as { detail?: unknown }).detail)
        : null;
    const code =
      body && typeof body === "object" && "code" in body
        ? stringValue((body as { code?: unknown }).code)
        : null;
    if (detail && code) return `${detail} (${code})`;
    if (detail) return detail;
    if (code) return code;
    return JSON.stringify(body);
  }
  return (await response.text().catch(() => "")).slice(0, 300);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function gatewayUrl(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  const prefix = url.pathname.replace(/\/$/, "");
  url.pathname = `${prefix}${path}`;
  return url.toString();
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const string = stringValue(value);
    if (string) return string;
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return null;
}
