import type {
  PlatformStatusGetResponses,
  PlatformVerifycredentialPostResponses,
} from "@/generated/daemon/types.gen";
import { buildVellumMutatingHeaders } from "@/lib/auth/request-headers";
import { resolveSupportsCredentialVerification } from "@/lib/backwards-compat/credential-verification";
import {
  getActiveAssistant,
  getLocalGatewayUrl,
  getPlatformRuntimeUrl,
  getSelectedAssistant,
  isLocalAssistant,
  isLocalClient,
  isLocalGatewayAssistant,
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
import { detectElectronHostOS } from "@/runtime/platform-detection";
import { getElectronSessionToken } from "@/runtime/session-token";
import {
  getActiveOrganizationIdForRequests,
  useOrganizationStore,
} from "@/stores/organization-store";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ELECTRON_RENDERER_ORIGIN_HEADER = "X-Vellum-Electron-Renderer-Origin";

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
  /**
   * Whether a stored credential the platform has rejected may be rotated.
   *
   * Off by default, so the routine bootstrap never replaces a credential
   * unattended. Rotation is a credential mutation and the user is the one who
   * asks for it, from the repair action on the credential notification or by
   * signing in from the CLI. The bootstrap's job is to provision what is
   * missing, not to repair what is broken.
   */
  rotateRejectedCredential?: boolean;
};

const platformAssistantIdCache = new Map<string, Promise<string>>();

/**
 * Backoff schedule for the best-effort bootstrap. After a daemon restart the
 * gateway 502s every proxied /v1/* request (including the secret injection
 * that stores the platform credentials) until the daemon is listening again —
 * a window observed to last ~90s — so the schedule must outlast it.
 */
const BOOTSTRAP_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

let bootstrapRetryDelaysMs: readonly number[] = BOOTSTRAP_RETRY_DELAYS_MS;

/** Assistants with a bootstrap retry loop currently running. */
const activeBootstraps = new Set<string>();

export function resetLocalPlatformIdentityCacheForTesting(): void {
  platformAssistantIdCache.clear();
  activeBootstraps.clear();
}

export function setBootstrapRetryDelaysForTesting(
  delays: readonly number[] | null,
): void {
  bootstrapRetryDelaysMs = delays ?? BOOTSTRAP_RETRY_DELAYS_MS;
}

export async function resolveLocalAssistantPlatformIdentity(
  assistantId: string,
  options: ResolveLocalAssistantPlatformIdentityOptions = {},
): Promise<string> {
  if (
    !isLocalClient() ||
    isRemoteGatewayMode() ||
    isPlatformDisabled() ||
    isUuid(assistantId)
  ) {
    return assistantId;
  }

  // A repair acts on any assistant this client reaches over the local
  // gateway; bootstrap provisions only the ones the web lifecycle owns.
  const assistant = resolveLocalAssistant(
    assistantId,
    options.rotateRejectedCredential
      ? isLocalGatewayAssistant
      : isLocalAssistant,
  );
  if (!assistant) {
    return assistantId;
  }

  const cached = platformAssistantIdCache.get(assistant.assistantId);
  if (cached) {
    return cached;
  }

  const promise = ensureLocalAssistantPlatformIdentity(assistant, {
    allowGatewayRepair: options.allowGatewayRepair ?? true,
    rotateRejectedCredential: options.rotateRejectedCredential ?? false,
  });
  platformAssistantIdCache.set(assistant.assistantId, promise);
  try {
    return await promise;
  } catch (error) {
    platformAssistantIdCache.delete(assistant.assistantId);
    throw error;
  }
}

/**
 * Re-resolve this assistant's platform identity from scratch, rotating a
 * rejected managed credential in the process.
 *
 * The ordinary bootstrap cannot serve an in-session recovery. It runs when a
 * platform session is confirmed and when the assistant changes, so nothing
 * re-runs it when a credential is rejected mid-session, and its per-assistant
 * promise cache would return the already-settled result if anything did. Both
 * are right for a bootstrap and wrong for a repair, so this drops the cache
 * entry and resolves again.
 *
 * Rejects with the underlying reason (no platform session, unreachable
 * gateway, rotation refused) so a caller can show it rather than reporting a
 * failure it cannot explain.
 */
export type LocalPlatformCredentialRecoveryReason =
  /** Nothing is selected to repair. */
  | "no_assistant"
  /**
   * This client cannot perform the repair for this assistant: it is not the
   * local client, it is served through a remote gateway, platform features
   * are off, or the assistant is platform-hosted and re-provisions its own
   * key.
   */
  | "cannot_act_here"
  /** The platform rejected the replacement too. */
  | "replacement_rejected"
  /** The replacement was stored but the platform could not confirm it. */
  | "unconfirmed";

/**
 * A repair that could not complete, with a typed reason.
 *
 * The reason is the contract; `message` is for logs and error reporting.
 * Surfaces render the reason through their own catalogs, so no English here
 * ever reaches a reader, and platform or transport detail never leaks into
 * user-facing copy.
 */
export class LocalPlatformCredentialRecoveryError extends Error {
  readonly reason: LocalPlatformCredentialRecoveryReason;

  constructor(reason: LocalPlatformCredentialRecoveryReason, message: string) {
    super(message);
    this.name = "LocalPlatformCredentialRecoveryError";
    this.reason = reason;
  }
}

/**
 * The assistant a repair would act on, or null when this client cannot act
 * on it. One predicate for the surface that offers the repair and the repair
 * itself, so a button is never rendered for a repair that would refuse.
 *
 * `resolveLocalAssistantPlatformIdentity` returns an id untouched for
 * anything it does not provision for, so a repair not guarded by this would
 * resolve successfully having done nothing. A platform-hosted assistant is
 * not a gap: the platform re-provisions its own key, so the repair belongs
 * to nobody here.
 *
 * Scoped to `isLocalGatewayAssistant`, wider than the `isLocalAssistant` set
 * bootstrap provisions for: a local Docker instance is never hatched, woken
 * or retired from here, but rotating and storing its credential is a write
 * over the local gateway it already exposes, the same write a plain local
 * assistant takes, and the CLI login flow repairs it the same way.
 */
function recoverableLocalAssistant(
  assistantId?: string,
): LockfileAssistant | null {
  const target = assistantId ?? getSelectedAssistant()?.assistantId;
  if (
    !target ||
    !isLocalClient() ||
    isRemoteGatewayMode() ||
    isPlatformDisabled() ||
    isUuid(target)
  ) {
    return null;
  }
  return resolveLocalAssistant(target, isLocalGatewayAssistant);
}

/** Whether {@link recoverLocalAssistantPlatformCredential} can act here. */
export function canRecoverLocalAssistantPlatformCredential(
  assistantId?: string,
): boolean {
  return recoverableLocalAssistant(assistantId) !== null;
}

export async function recoverLocalAssistantPlatformCredential(
  assistantId?: string,
): Promise<void> {
  const target = assistantId ?? getSelectedAssistant()?.assistantId;
  if (!target) {
    throw new LocalPlatformCredentialRecoveryError(
      "no_assistant",
      "No assistant is selected.",
    );
  }

  const assistant = recoverableLocalAssistant(target);
  if (!assistant) {
    throw new LocalPlatformCredentialRecoveryError(
      "cannot_act_here",
      "This client cannot restore the credential for this assistant.",
    );
  }

  platformAssistantIdCache.delete(assistant.assistantId);

  await resolveLocalAssistantPlatformIdentity(target, {
    allowGatewayRepair: true,
    rotateRejectedCredential: true,
  });

  // Storing a credential proves the write landed, not that it authenticates: a
  // replacement can be rejected in turn. Confirm before the caller reports
  // success, so a repair that did not repair anything reads as a failure the
  // reader can see rather than a receipt for something that never happened.
  //
  // A daemon that predates the verification route cannot confirm anything,
  // and its 404 would read as a failed repair after a successful rotation,
  // inviting another. On those daemons the stored replacement is the repair,
  // as it always was there. Resolved against a version held for this
  // assistant: the sync snapshot's false-on-unknown would skip the check on a
  // daemon that has it, and an unscoped read could let the assistant the user
  // just switched away from vouch for this one.
  if (!(await resolveSupportsCredentialVerification(assistant.assistantId))) {
    return;
  }
  const verified = await verifyPlatformCredential(assistant);
  if (verified === "rejected") {
    throw new LocalPlatformCredentialRecoveryError(
      "replacement_rejected",
      "The platform rejected the replacement credential.",
    );
  }
  if (verified !== "valid") {
    throw new LocalPlatformCredentialRecoveryError(
      "unconfirmed",
      "The replacement credential was stored but could not be confirmed.",
    );
  }
}

/**
 * Ask the assistant to check its stored managed credential against the
 * platform. Returns `"unknown"` when the check itself could not be run, which
 * is not evidence either way.
 */
async function verifyPlatformCredential(
  assistant: LockfileAssistant,
): Promise<"valid" | "rejected" | "unknown"> {
  try {
    const gateway = await ensureGatewayAccess(assistant, {
      allowGatewayRepair: false,
    });
    // Addressed to this assistant's gateway with the token minted for it,
    // like the status read above, rather than through the daemon client: the
    // client routes to whichever assistant the app is connected to, and a
    // repair can run for an assistant before that connection is primed.
    const response = await fetch(
      gatewayUrl(gateway.gatewayUrl, "/v1/platform/verify-credential"),
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${gateway.actorToken}`,
        },
        credentials: "omit",
      },
    );
    if (!response.ok) {
      return "unknown";
    }
    // The route's own response shape; the value check keeps a malformed body
    // from being read as a verdict.
    const body = (await response.json()) as Partial<
      PlatformVerifycredentialPostResponses[200]
    >;
    return body.status === "valid" || body.status === "rejected"
      ? body.status
      : "unknown";
  } catch {
    return "unknown";
  }
}

export function bootstrapLocalAssistantPlatformIdentity(
  assistantId?: string,
  options: BootstrapLocalAssistantPlatformIdentityOptions = {},
): void {
  if (!isLocalClient() || isRemoteGatewayMode() || isPlatformDisabled()) {
    return;
  }

  let targetAssistantId = assistantId;
  if (!targetAssistantId) {
    const assistant = getSelectedAssistant();
    if (!assistant || !isLocalAssistant(assistant)) {
      return;
    }
    targetAssistantId = assistant.assistantId;
  }

  // One retrying bootstrap per assistant — a second trigger while a loop is
  // waiting out a backoff delay would race the same registration and
  // secret-injection flow.
  if (activeBootstraps.has(targetAssistantId)) {
    return;
  }
  activeBootstraps.add(targetAssistantId);
  const target = targetAssistantId;

  void (async () => {
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await resolveLocalAssistantPlatformIdentity(target, {
            allowGatewayRepair: options.allowGatewayRepair ?? false,
          });
          return;
        } catch (error) {
          const delayMs = bootstrapRetryDelaysMs[attempt];
          if (delayMs === undefined) {
            (
              options.onError ??
              ((e: unknown) => {
                console.warn("local assistant platform bootstrap failed", e);
              })
            )(error);
            return;
          }
          console.warn(
            `local assistant platform bootstrap attempt ${attempt + 1} failed, retrying in ${delayMs}ms`,
            error,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    } finally {
      activeBootstraps.delete(target);
    }
  })();
}

/**
 * The lockfile entry for `assistantId` when it is the active or selected
 * assistant and `eligible` accepts it, else null. Bootstrap passes
 * `isLocalAssistant`, the assistants the web lifecycle owns; a repair passes
 * `isLocalGatewayAssistant`, every assistant whose gateway this client can
 * write a credential to.
 */
function resolveLocalAssistant(
  assistantId: string,
  eligible: (assistant: LockfileAssistant) => boolean,
): LockfileAssistant | null {
  const active = getActiveAssistant();
  if (active?.assistantId === assistantId && eligible(active)) {
    return active;
  }
  const selected = getSelectedAssistant();
  if (selected?.assistantId === assistantId && eligible(selected)) {
    return selected;
  }
  return null;
}

async function ensureLocalAssistantPlatformIdentity(
  assistant: LockfileAssistant,
  options: { allowGatewayRepair: boolean; rotateRejectedCredential: boolean },
): Promise<string> {
  const gateway = await ensureGatewayAccess(assistant, options);
  const status = await fetchPlatformStatus(gateway, assistant.assistantId);
  const statusPlatformAssistantId =
    status?.assistantId && isUuid(status.assistantId)
      ? status.assistantId
      : null;
  // A stored key the platform has rejected is worse than no key: every call
  // fails and the assistant cannot mint a replacement for itself. The platform
  // leaves self-hosted and local registrations to their client on purpose
  // (`recover_expired_assistant_api_key` excludes them), so a repair here is
  // the only thing that rotates one.
  // A repair rotates because it was asked for, not because the daemon agrees
  // the credential is dead. The verdict is in-process and resets to `unknown`
  // when the daemon restarts, while the notification offering the repair
  // persists, so requiring a reported rejection would leave the button inert
  // in exactly the case it exists for: a dead credential surviving a restart.
  //
  // Rotating on request is safe. The platform keeps the outgoing key valid for
  // a grace period, so a repair the credential did not need costs a rotation
  // and nothing else. Routine resolution never sets this and never rotates.
  const repairRequested = options.rotateRejectedCredential;

  if (
    statusPlatformAssistantId &&
    status?.hasAssistantApiKey !== false &&
    !repairRequested
  ) {
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

  // `ensureRegistration` hands back a key only for a registration that had
  // none, so a repair needs the explicit rotation. The platform keeps the
  // outgoing key valid for a grace period rather than revoking it on the spot,
  // so a rotation whose injection fails leaves the install no worse off.
  let assistantApiKey = stringValue(registration.assistant_api_key);
  if (
    !assistantApiKey &&
    (status?.hasAssistantApiKey !== true || repairRequested)
  ) {
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

/**
 * The daemon's `platform/status`, null on any failure. A null `actorToken`
 * sends no bearer: the paired proxy's trusted host installs its own.
 */
export async function fetchPlatformStatus(
  gateway: { gatewayUrl: string; actorToken: string | null },
  runtimeAssistantId: string,
): Promise<LocalPlatformStatus | null> {
  const url = gatewayUrl(
    gateway.gatewayUrl,
    `/v1/assistants/${encodeURIComponent(runtimeAssistantId)}/platform/status`,
  );
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...(gateway.actorToken && {
        Authorization: `Bearer ${gateway.actorToken}`,
      }),
    },
    credentials: "omit",
  }).catch(() => null);
  if (!response?.ok) {
    return null;
  }

  // The daemon's own response shape. Partial because this bundle serves
  // daemons of any age, and a field the current schema requires may be absent
  // from an older one; absent reads as null, which the gates treat as unknown.
  const body = (await response.json().catch(() => null)) as Partial<
    PlatformStatusGetResponses[200]
  > | null;
  return {
    assistantId: body?.assistantId ?? null,
    baseUrl: body?.baseUrl ?? null,
    organizationId: body?.organizationId ?? null,
    hasAssistantApiKey: body?.hasAssistantApiKey ?? null,
    clientInstallationId: body?.clientInstallationId ?? null,
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
  if (existing) {
    return existing;
  }

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
  const electronHostOS = detectElectronHostOS();
  if (electronHostOS) {
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
      credentials: electronHostOS ? "omit" : "same-origin",
      body: JSON.stringify({
        client_installation_id: clientInstallationId,
        runtime_assistant_id: assistant.assistantId,
        client_platform: electronHostOS ?? "web",
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

  // The API key is the sentinel the status probe reports as
  // has_assistant_api_key, and the bootstrap early-returns when it is
  // present. Store it only after every other credential has landed, so a
  // partial write can never look "healthy" to a later retry and suppress
  // the re-injection of the missing credentials.
  if (params.assistantApiKey) {
    await injectCredential(
      gateway,
      "vellum:assistant_api_key",
      params.assistantApiKey,
    );
  }
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
    if (detail && code) {
      return `${detail} (${code})`;
    }
    if (detail) {
      return detail;
    }
    if (code) {
      return code;
    }
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

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const string = stringValue(value);
    if (string) {
      return string;
    }
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
