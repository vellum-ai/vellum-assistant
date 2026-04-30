import {
  chmodSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from "fs";
import { join, dirname } from "path";

import { getLockfilePlatformBaseUrl } from "./assistant-config.js";
import { getConfigDir } from "./environments/paths.js";
import { getCurrentEnvironment } from "./environments/resolve.js";

function getPlatformTokenPath(): string {
  return join(getConfigDir(getCurrentEnvironment()), "platform-token");
}

/**
 * Resolve the platform API base URL. Resolution order:
 *   1. `platformBaseUrl` persisted on the lockfile by
 *      {@link syncConfigToLockfile} when the active assistant was last
 *      hatched/waked. This is the source of truth for "what URL does the
 *      currently-active assistant target" — reading the workspace
 *      `config.json` directly is incorrect for multi-instance and
 *      non-production XDG layouts because the CLI process has no way to
 *      know which instance to read from without first consulting the
 *      lockfile anyway.
 *   2. `VELLUM_PLATFORM_URL` env var (explicit override, e.g. in CI).
 *   3. The current environment's seed URL (e.g. `https://dev-platform.vellum.ai`
 *      for `VELLUM_ENVIRONMENT=dev`, `https://platform.vellum.ai` for prod).
 *      This makes the CLI environment-aware when no lockfile entry exists yet.
 */
export function getPlatformUrl(): string {
  const lockfileUrl = getLockfilePlatformBaseUrl();
  return (
    lockfileUrl ||
    process.env.VELLUM_PLATFORM_URL?.trim() ||
    getCurrentEnvironment().platformUrl
  );
}

/**
 * Resolve the web app (Next.js) base URL for browser-facing pages like
 * `/account/login`. Mirrors `VellumEnvironment.resolvedWebURL` on the
 * Swift side.
 *
 * Resolution order:
 *   1. `VELLUM_WEB_URL` env var (explicit override)
 *   2. The current environment's seed web URL
 */
export function getWebUrl(): string {
  return process.env.VELLUM_WEB_URL?.trim() || getCurrentEnvironment().webUrl;
}

export function readPlatformToken(): string | null {
  try {
    return readFileSync(getPlatformTokenPath(), "utf-8").trim();
  } catch {
    return null;
  }
}

export function savePlatformToken(token: string): void {
  const tokenPath = getPlatformTokenPath();
  const dir = dirname(tokenPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
}

export function clearPlatformToken(): void {
  try {
    unlinkSync(getPlatformTokenPath());
  } catch {
    // already doesn't exist
  }
}

const VAK_PREFIX = "vak_";

/**
 * Sync helper – returns only the token-based auth header.
 *
 * Used internally by {@link fetchOrganizationId} (which cannot call the
 * async {@link authHeaders} without creating a cycle) and by functions
 * that already have an org ID in hand.
 */
function tokenAuthHeader(token: string): Record<string, string> {
  if (token.startsWith(VAK_PREFIX)) {
    return { Authorization: `Bearer ${token}` };
  }
  return { "X-Session-Token": token };
}

/** Module-level cache for org IDs to avoid redundant fetches in polling loops. */
const orgIdCache = new Map<string, { orgId: string; expiresAt: number }>();
const ORG_ID_CACHE_TTL_MS = 60_000; // 60 seconds

/**
 * Returns the full set of headers needed for an authenticated platform
 * API request:
 *
 * - `Content-Type: application/json`
 * - The appropriate auth header (`Authorization: Bearer` for `vak_`
 *   API keys, `X-Session-Token` for session tokens).
 * - `Vellum-Organization-Id` – fetched from the platform.  Only
 *   included for session-token callers; API keys are already org-scoped.
 *
 * The org ID is cached per (token, platformUrl) for 60 seconds to avoid
 * redundant HTTP requests in tight polling loops.
 *
 * Auth errors (401 / 403) from the org-ID fetch are logged with a
 * user-friendly message before re-throwing, so callers don't need to
 * repeat that logic.
 */
export async function authHeaders(
  token: string,
  platformUrl?: string,
): Promise<Record<string, string>> {
  const base: Record<string, string> = {
    "Content-Type": "application/json",
    ...tokenAuthHeader(token),
  };

  if (token.startsWith(VAK_PREFIX)) {
    // API keys are org-scoped – no need to fetch the org ID.
    return base;
  }

  const cacheKey = `${token}::${platformUrl ?? ""}`;
  const cached = orgIdCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return { ...base, "Vellum-Organization-Id": cached.orgId };
  }

  try {
    const orgId = await fetchOrganizationId(token, platformUrl);
    orgIdCache.set(cacheKey, {
      orgId,
      expiresAt: Date.now() + ORG_ID_CACHE_TTL_MS,
    });
    return { ...base, "Vellum-Organization-Id": orgId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("401") || msg.includes("403")) {
      console.error("Authentication failed. Run 'vellum login' to refresh.");
    } else {
      console.error(`Failed to fetch organization: ${msg}`);
    }
    throw err;
  }
}

export interface HatchedAssistant {
  id: string;
  name: string;
  status: string;
}

export interface HatchAssistantResult {
  assistant: HatchedAssistant;
  /** true when the platform returned an existing assistant (HTTP 200) */
  reusedExisting: boolean;
}

// ---------------------------------------------------------------------------
// Self-hosted local assistant registration
// ---------------------------------------------------------------------------

export interface EnsureRegistrationResponse {
  assistant: { id: string; name: string };
  registration: {
    client_installation_id: string;
    runtime_assistant_id: string;
    client_platform: string;
  };
  assistant_api_key: string | null;
  webhook_secret: string;
}

/**
 * Register (or re-confirm) a self-hosted local assistant with the platform.
 *
 * Calls `POST /v1/assistants/self-hosted-local/ensure-registration/`.
 * The endpoint is idempotent: the first call provisions an API key;
 * subsequent calls return `assistant_api_key: null`.
 */
export async function ensureSelfHostedLocalRegistration(
  token: string,
  organizationId: string,
  clientInstallationId: string,
  runtimeAssistantId: string,
  clientPlatform: string,
  assistantVersion?: string,
  platformUrl?: string,
): Promise<EnsureRegistrationResponse> {
  const resolvedUrl = platformUrl || getPlatformUrl();
  const body: Record<string, string> = {
    client_installation_id: clientInstallationId,
    runtime_assistant_id: runtimeAssistantId,
    client_platform: clientPlatform,
  };
  if (assistantVersion) {
    body.assistant_version = assistantVersion;
  }

  const response = await fetch(
    `${resolvedUrl}/v1/assistants/self-hosted-local/ensure-registration/`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Session-Token": token,
        "Vellum-Organization-Id": organizationId,
      },
      body: JSON.stringify(body),
    },
  );

  if (response.status === 401 || response.status === 403) {
    throw new Error("Authentication required for assistant registration.");
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Registration failed (${response.status}): ${detail || response.statusText}`,
    );
  }

  return (await response.json()) as EnsureRegistrationResponse;
}

// ---------------------------------------------------------------------------
// API key reprovisioning
// ---------------------------------------------------------------------------

export interface ReprovisionApiKeyResponse {
  provisioning: {
    assistant_api_key: string;
  };
}

/**
 * Reprovision (rotate) the API key for a self-hosted local assistant.
 *
 * Calls `POST /v1/assistants/self-hosted-local/reprovision-api-key/`.
 * Returns a fresh API key. The previous key is revoked server-side.
 */
export async function reprovisionAssistantApiKey(
  token: string,
  organizationId: string,
  clientInstallationId: string,
  runtimeAssistantId: string,
  clientPlatform: string,
  assistantVersion?: string,
  platformUrl?: string,
): Promise<ReprovisionApiKeyResponse> {
  const resolvedUrl = platformUrl || getPlatformUrl();
  const body: Record<string, string> = {
    client_installation_id: clientInstallationId,
    runtime_assistant_id: runtimeAssistantId,
    client_platform: clientPlatform,
  };
  if (assistantVersion) {
    body.assistant_version = assistantVersion;
  }

  const response = await fetch(
    `${resolvedUrl}/v1/assistants/self-hosted-local/reprovision-api-key/`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Session-Token": token,
        "Vellum-Organization-Id": organizationId,
      },
      body: JSON.stringify(body),
    },
  );

  if (response.status === 401 || response.status === 403) {
    throw new Error("Authentication required for API key reprovisioning.");
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `API key reprovisioning failed (${response.status}): ${detail || response.statusText}`,
    );
  }

  return (await response.json()) as ReprovisionApiKeyResponse;
}

// ---------------------------------------------------------------------------
// Credential reading from running assistant via gateway
// ---------------------------------------------------------------------------

export interface GatewayCredentialResult {
  /** The credential value, if found. */
  value: string | null;
  /** True when the gateway/daemon was unreachable (network error, timeout, etc.). */
  unreachable: boolean;
}

/**
 * Read an existing credential from the assistant's secret store via the
 * gateway-proxied `POST /v1/secrets/read` endpoint (with `reveal: true`).
 *
 * Returns a result distinguishing "key not found" (`value: null,
 * unreachable: false`) from "gateway unreachable" (`value: null,
 * unreachable: true`). Callers should only reprovision when the gateway
 * is reachable but the key is genuinely missing — reprovisioning while
 * the gateway is down would revoke the old key server-side without being
 * able to inject the replacement.
 *
 * Never throws.
 */
export async function readGatewayCredential(
  gatewayUrl: string,
  name: string,
  bearerToken?: string,
): Promise<GatewayCredentialResult> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (bearerToken) {
      headers["Authorization"] = `Bearer ${bearerToken}`;
    }

    const response = await fetch(`${gatewayUrl}/v1/secrets/read`, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "credential", name, reveal: true }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      // 5xx means the gateway/daemon backend is down — treat as unreachable
      // so callers don't revoke a potentially valid key.
      return { value: null, unreachable: response.status >= 500 };
    }

    const json = (await response.json()) as {
      found: boolean;
      value?: string;
      unreachable?: boolean;
    };
    // The daemon's /v1/secrets/read returns `unreachable: true` when the
    // credential backend (CES) can't be reached. Respect that signal.
    if (json.unreachable) {
      return { value: null, unreachable: true };
    }
    return {
      value: json.found && json.value ? json.value : null,
      unreachable: false,
    };
  } catch {
    // Network error, timeout, or gateway down
    return { value: null, unreachable: true };
  }
}

// ---------------------------------------------------------------------------
// Credential injection into running assistant via gateway
// ---------------------------------------------------------------------------

/**
 * Inject a single credential into the assistant's secret store via the
 * gateway's `POST /v1/secrets` endpoint.
 *
 * Mirrors the desktop app's `GatewayHTTPClient.post(path: "secrets", …)`
 * calls in `LocalAssistantBootstrapService.swift`.
 */
async function injectGatewayCredential(
  gatewayUrl: string,
  name: string,
  value: string,
  bearerToken?: string,
): Promise<boolean> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (bearerToken) {
    headers["Authorization"] = `Bearer ${bearerToken}`;
  }

  const response = await fetch(`${gatewayUrl}/v1/secrets`, {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "credential", name, value }),
    signal: AbortSignal.timeout(10_000),
  });
  return response.ok;
}

export interface CredentialInjectionParams {
  gatewayUrl: string;
  bearerToken?: string;
  assistantApiKey?: string | null;
  platformAssistantId: string;
  platformBaseUrl: string;
  organizationId: string;
  userId?: string;
  webhookSecret?: string | null;
}

/**
 * Inject platform credentials into a running assistant via the gateway,
 * mirroring `LocalAssistantBootstrapService.injectKeyIntoAssistant` et al.
 *
 * Each credential is posted individually. Failures are collected but do
 * not prevent the remaining credentials from being injected.
 *
 * Returns true if all injections succeeded.
 */
export async function injectCredentialsIntoAssistant(
  params: CredentialInjectionParams,
): Promise<boolean> {
  const inject = (name: string, value: string) =>
    injectGatewayCredential(params.gatewayUrl, name, value, params.bearerToken);

  const promises: Promise<boolean>[] = [];

  if (params.assistantApiKey) {
    promises.push(inject("vellum:assistant_api_key", params.assistantApiKey));
  }

  promises.push(
    inject("vellum:platform_assistant_id", params.platformAssistantId),
  );

  promises.push(inject("vellum:platform_base_url", params.platformBaseUrl));

  promises.push(
    inject("vellum:platform_organization_id", params.organizationId),
  );

  if (params.userId) {
    promises.push(inject("vellum:platform_user_id", params.userId));
  }

  if (params.webhookSecret) {
    promises.push(inject("vellum:webhook_secret", params.webhookSecret));
  }

  const results = await Promise.all(promises);
  return results.every(Boolean);
}

export async function hatchAssistant(
  token: string,
  platformUrl?: string,
): Promise<HatchAssistantResult> {
  const resolvedUrl = platformUrl || getPlatformUrl();
  const url = `${resolvedUrl}/v1/assistants/hatch/`;

  const response = await fetch(url, {
    method: "POST",
    headers: await authHeaders(token, platformUrl),
    body: JSON.stringify({}),
  });

  if (response.ok) {
    const assistant = (await response.json()) as HatchedAssistant;
    return { assistant, reusedExisting: response.status === 200 };
  }

  if (response.status === 401 || response.status === 403) {
    const detail = (await response.json().catch(() => ({}))) as {
      detail?: string;
    };
    throw new Error(
      detail.detail ??
        "Invalid or expired token. Run `vellum login` to re-authenticate.",
    );
  }

  if (response.status === 402) {
    throw new Error("Insufficient balance to hatch a new assistant.");
  }

  const errorBody = (await response.json().catch(() => ({}))) as {
    detail?: string;
  };
  throw new Error(
    errorBody.detail ??
      `Platform API error: ${response.status} ${response.statusText}`,
  );
}

/**
 * Lightweight pre-check: returns the first active managed assistant for the
 * authenticated user, or `null` if none exists. Calls `GET /v1/assistants/`
 * and looks for any assistant with status "active".
 *
 * Used by the teleport flow to block BEFORE the expensive GCS upload when
 * the user already has a platform assistant.
 */
export async function checkExistingPlatformAssistant(
  token: string,
  platformUrl?: string,
): Promise<HatchedAssistant | null> {
  const resolvedUrl = platformUrl || getPlatformUrl();
  const url = `${resolvedUrl}/v1/assistants/`;

  const response = await fetch(url, {
    headers: await authHeaders(token, platformUrl),
  });

  if (!response.ok) {
    // Non-fatal: if the list call fails, fall through and let hatch handle it.
    return null;
  }

  const body = (await response.json()) as {
    results?: HatchedAssistant[];
  };
  const active = body.results?.find((a) => a.status === "active");
  return active ?? null;
}

/**
 * Fetch all active assistants for the authenticated user from the platform.
 * Returns an empty array on failure (non-fatal).
 */
export async function fetchPlatformAssistants(
  token: string,
  platformUrl?: string,
): Promise<HatchedAssistant[]> {
  const resolvedUrl = platformUrl || getPlatformUrl();
  const url = `${resolvedUrl}/v1/assistants/`;

  const response = await fetch(url, {
    headers: await authHeaders(token, platformUrl),
  });

  if (!response.ok) return [];

  const body = (await response.json()) as {
    results?: HatchedAssistant[];
  };

  return (body.results ?? []).filter((a) => a.status === "active");
}

export interface PlatformUser {
  id: string;
  email: string;
  display: string;
}

interface OrganizationListResponse {
  results: { id: string; name: string }[];
}

export async function fetchOrganizationId(
  token: string,
  platformUrl?: string,
): Promise<string> {
  const resolvedUrl = platformUrl || getPlatformUrl();
  const url = `${resolvedUrl}/v1/organizations/`;
  const response = await fetch(url, {
    headers: { ...tokenAuthHeader(token) },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch organizations from ${resolvedUrl} (${response.status}). Try logging in again.`,
    );
  }

  const body = (await response.json()) as OrganizationListResponse;
  const orgId = body.results?.[0]?.id;
  if (!orgId) {
    throw new Error("No organization found for this account.");
  }
  return orgId;
}

interface AllauthSessionResponse {
  status: number;
  data: {
    user: {
      id: string;
      email: string;
      display: string;
    };
  };
}

export async function fetchCurrentUser(
  token: string,
  platformUrl?: string,
): Promise<PlatformUser> {
  const resolvedUrl = platformUrl || getPlatformUrl();
  const url = `${resolvedUrl}/_allauth/app/v1/auth/session`;
  const response = await fetch(url, {
    headers: { "X-Session-Token": token },
  });

  if (!response.ok) {
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 410
    ) {
      throw new Error("Invalid or expired token. Please login again.");
    }
    throw new Error(
      `Platform API error: ${response.status} ${response.statusText}`,
    );
  }

  const body = (await response.json()) as AllauthSessionResponse;
  return body.data.user;
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

export async function rollbackPlatformAssistant(
  token: string,
  version?: string,
  platformUrl?: string,
): Promise<{ detail: string; version: string | null }> {
  const resolvedUrl = platformUrl || getPlatformUrl();
  const response = await fetch(`${resolvedUrl}/v1/assistants/rollback/`, {
    method: "POST",
    headers: await authHeaders(token, platformUrl),
    body: JSON.stringify(version ? { version } : {}),
  });

  const body = (await response.json().catch(() => ({}))) as {
    detail?: string;
    version?: string | null;
  };

  if (response.status === 200) {
    return { detail: body.detail ?? "", version: body.version ?? null };
  }

  if (response.status === 400) {
    throw new Error(body.detail ?? "Rollback failed: bad request");
  }

  if (response.status === 404) {
    throw new Error(body.detail ?? "Rollback target not found");
  }

  if (response.status === 502) {
    throw new Error(body.detail ?? "Rollback failed: transport error");
  }

  throw new Error(`Rollback failed: ${response.status} ${response.statusText}`);
}

// ---------------------------------------------------------------------------
// Signed-URL upload flow
// ---------------------------------------------------------------------------

export async function platformRequestUploadUrl(
  token: string,
  platformUrl?: string,
): Promise<{ uploadUrl: string; bundleKey: string; expiresAt: string }> {
  const resolvedUrl = platformUrl || getPlatformUrl();
  const response = await fetch(`${resolvedUrl}/v1/migrations/upload-url/`, {
    method: "POST",
    headers: await authHeaders(token, platformUrl),
    body: JSON.stringify({ content_type: "application/octet-stream" }),
  });

  if (response.status === 201) {
    const body = (await response.json()) as {
      upload_url: string;
      bundle_key: string;
      expires_at: string;
    };
    return {
      uploadUrl: body.upload_url,
      bundleKey: body.bundle_key,
      expiresAt: body.expires_at,
    };
  }

  if (response.status === 404 || response.status === 503) {
    throw new Error(
      "Signed uploads are not available on this platform instance",
    );
  }

  const errorBody = (await response.json().catch(() => ({}))) as {
    detail?: string;
  };
  throw new Error(
    errorBody.detail ??
      `Failed to request upload URL: ${response.status} ${response.statusText}`,
  );
}

export async function platformUploadToSignedUrl(
  uploadUrl: string,
  bundleData: Uint8Array<ArrayBuffer>,
): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
    },
    body: new Blob([bundleData]),
    signal: AbortSignal.timeout(600_000),
  });

  if (!response.ok) {
    throw new Error(
      `Upload to signed URL failed: ${response.status} ${response.statusText}`,
    );
  }
}

export async function platformImportPreflightFromGcs(
  bundleKey: string,
  token: string,
  platformUrl?: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const resolvedUrl = platformUrl || getPlatformUrl();
  const response = await fetch(
    `${resolvedUrl}/v1/migrations/import-preflight-from-gcs/`,
    {
      method: "POST",
      headers: await authHeaders(token, platformUrl),
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({ bundle_key: bundleKey }),
    },
  );

  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return { statusCode: response.status, body };
}

export async function platformImportBundleFromGcs(
  bundleKey: string,
  token: string,
  platformUrl?: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const resolvedUrl = platformUrl || getPlatformUrl();
  const response = await fetch(
    `${resolvedUrl}/v1/migrations/import-from-gcs/`,
    {
      method: "POST",
      headers: await authHeaders(token, platformUrl),
      body: JSON.stringify({ bundle_key: bundleKey }),
      signal: AbortSignal.timeout(60_000),
    },
  );

  if (response.status === 413) {
    throw new Error("Bundle too large to import");
  }

  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return { statusCode: response.status, body };
}

// ---------------------------------------------------------------------------
// Unified signed-url + job-status endpoints (teleport-gcs-unify)
// ---------------------------------------------------------------------------

/**
 * Discriminated union representing the unified migration job status shape
 * returned by `GET /v1/migrations/jobs/{job_id}/` on both the platform and
 * the local runtime.
 */
export type UnifiedJobStatus =
  | {
      jobId: string;
      type: "export" | "import";
      status: "processing";
    }
  | {
      jobId: string;
      type: "export" | "import";
      status: "complete";
      bundleKey?: string;
      result?: unknown;
    }
  | {
      jobId: string;
      type: "export" | "import";
      status: "failed";
      error: string;
    };

interface RawUnifiedJobStatus {
  job_id: string;
  type: "export" | "import";
  status: "processing" | "complete" | "failed";
  bundle_key?: string;
  result?: unknown;
  error?: string;
}

/**
 * Normalise the wire-format job-status payload into the TypeScript
 * discriminated union. Shared between platform and local-runtime helpers
 * since both endpoints return the same shape.
 */
export function parseUnifiedJobStatus(
  raw: RawUnifiedJobStatus,
): UnifiedJobStatus {
  if (raw.status === "processing") {
    return { jobId: raw.job_id, type: raw.type, status: "processing" };
  }
  if (raw.status === "complete") {
    return {
      jobId: raw.job_id,
      type: raw.type,
      status: "complete",
      bundleKey: raw.bundle_key,
      result: raw.result,
    };
  }
  return {
    jobId: raw.job_id,
    type: raw.type,
    status: "failed",
    error: raw.error ?? "Job failed without an error message",
  };
}

/**
 * Request a signed URL from the platform for either uploading a new bundle
 * or downloading an existing one. Calls `POST /v1/migrations/signed-url/`.
 *
 * - `operation: "upload"` (optionally with `contentType` / `contentLength`)
 *   returns a URL the CLI can PUT a bundle to.
 * - `operation: "download"` with a `bundleKey` returns a URL the local
 *   runtime can GET the bundle from during an import-from-GCS flow.
 *
 * Retries once with a fresh org-ID cache on 401 to match the retry pattern
 * used by other authenticated platform helpers. 503 is bubbled up so
 * callers can decide to fall back (e.g. legacy inline upload).
 */
export async function platformRequestSignedUrl(
  params: {
    operation: "upload" | "download";
    bundleKey?: string;
    contentType?: string;
    contentLength?: number;
  },
  token: string,
  platformUrl?: string,
): Promise<{
  url: string;
  bundleKey: string;
  expiresAt: string;
  maxContentLength?: number;
}> {
  const resolvedUrl = platformUrl || getPlatformUrl();
  const body: Record<string, unknown> = { operation: params.operation };
  if (params.bundleKey !== undefined) body.bundle_key = params.bundleKey;
  if (params.contentType !== undefined) body.content_type = params.contentType;
  if (params.contentLength !== undefined) {
    body.content_length = params.contentLength;
  }

  const doRequest = async (): Promise<Response> =>
    fetch(`${resolvedUrl}/v1/migrations/signed-url/`, {
      method: "POST",
      headers: await authHeaders(token, platformUrl),
      body: JSON.stringify(body),
    });

  let response = await doRequest();

  if (response.status === 401) {
    // Invalidate the cached org-ID (if any) and retry once with a fresh
    // lookup. For session-token callers, a 401 frequently means the
    // cached org ID is stale — calling doRequest() again without clearing
    // the cache would just send the same stale header and fail again.
    orgIdCache.delete(`${token}::${platformUrl ?? ""}`);
    response = await doRequest();
  }

  if (response.status === 201 || response.status === 200) {
    const json = (await response.json()) as {
      url: string;
      bundle_key: string;
      expires_at: string;
      max_content_length?: number;
    };
    return {
      url: json.url,
      bundleKey: json.bundle_key,
      expiresAt: json.expires_at,
      maxContentLength: json.max_content_length,
    };
  }

  if (response.status === 503) {
    throw new Error(
      `Signed URL endpoint unavailable (503) — caller may fall back`,
    );
  }

  const errorBody = (await response.json().catch(() => ({}))) as {
    detail?: string;
  };
  throw new Error(
    errorBody.detail ??
      `Failed to request signed URL: ${response.status} ${response.statusText}`,
  );
}

/**
 * Poll the unified job-status endpoint on the platform. Calls
 * `GET /v1/migrations/jobs/{jobId}/` and parses into {@link UnifiedJobStatus}.
 */
export async function platformPollJobStatus(
  jobId: string,
  token: string,
  platformUrl?: string,
): Promise<UnifiedJobStatus> {
  const resolvedUrl = platformUrl || getPlatformUrl();
  const response = await fetch(`${resolvedUrl}/v1/migrations/jobs/${jobId}/`, {
    headers: await authHeaders(token, platformUrl),
  });

  if (response.status === 404) {
    throw new Error("Migration job not found");
  }

  if (!response.ok) {
    throw new Error(
      `Job status check failed: ${response.status} ${response.statusText}`,
    );
  }

  const raw = (await response.json()) as RawUnifiedJobStatus;
  return parseUnifiedJobStatus(raw);
}
