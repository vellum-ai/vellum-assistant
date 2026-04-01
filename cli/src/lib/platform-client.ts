import {
  chmodSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

function getXdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
}

function getPlatformTokenPath(): string {
  return join(getXdgConfigHome(), "vellum", "platform-token");
}

export function getPlatformUrl(): string {
  let configUrl: string | undefined;
  try {
    const base = process.env.BASE_DATA_DIR?.trim() || homedir();
    const configPath = join(base, ".vellum", "workspace", "config.json");
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<
        string,
        unknown
      >;
      const val = (raw.platform as Record<string, unknown> | undefined)
        ?.baseUrl;
      if (typeof val === "string" && val.trim()) configUrl = val.trim();
    }
  } catch {
    // Config not available — fall through
  }
  return (
    configUrl || process.env.VELLUM_PLATFORM_URL || "https://platform.vellum.ai"
  );
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
 * Returns the appropriate auth header for the given platform token.
 *
 * - `vak_`-prefixed tokens are long-lived platform API keys and use
 *   `Authorization: Bearer`.
 * - All other tokens are allauth session tokens and use `X-Session-Token`.
 */
export function authHeaders(token: string): Record<string, string> {
  if (token.startsWith(VAK_PREFIX)) {
    return { Authorization: `Bearer ${token}` };
  }
  return { "X-Session-Token": token };
}

export interface HatchedAssistant {
  id: string;
  name: string;
  status: string;
}

export async function hatchAssistant(
  token: string,
  orgId: string,
  platformUrl?: string,
): Promise<HatchedAssistant> {
  const resolvedUrl = platformUrl || getPlatformUrl();
  const url = `${resolvedUrl}/v1/assistants/hatch/`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(token),
      "Vellum-Organization-Id": orgId,
    },
    body: JSON.stringify({}),
  });

  if (response.ok) {
    return (await response.json()) as HatchedAssistant;
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
    headers: { ...authHeaders(token) },
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
  orgId: string,
  version?: string,
  platformUrl?: string,
): Promise<{ detail: string; version: string | null }> {
  const resolvedUrl = platformUrl || getPlatformUrl();
  const response = await fetch(`${resolvedUrl}/v1/assistants/rollback/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(token),
      "Vellum-Organization-Id": orgId,
    },
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
// Migration export
// ---------------------------------------------------------------------------

export async function platformInitiateExport(
  token: string,
  orgId: string,
  description?: string,
  platformUrl?: string,
): Promise<{ jobId: string; status: string }> {
  const resolvedUrl = platformUrl || getPlatformUrl();
  const response = await fetch(`${resolvedUrl}/v1/migrations/export/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(token),
      "Vellum-Organization-Id": orgId,
    },
    body: JSON.stringify({ description: description ?? "CLI backup" }),
  });

  if (response.status !== 201) {
    const body = (await response.json().catch(() => ({}))) as {
      detail?: string;
    };
    throw new Error(
      body.detail ??
        `Export initiation failed: ${response.status} ${response.statusText}`,
    );
  }

  const body = (await response.json()) as {
    job_id: string;
    status: string;
  };
  return { jobId: body.job_id, status: body.status };
}

export async function platformPollExportStatus(
  jobId: string,
  token: string,
  orgId: string,
  platformUrl?: string,
): Promise<{ status: string; downloadUrl?: string; error?: string }> {
  const resolvedUrl = platformUrl || getPlatformUrl();
  const response = await fetch(
    `${resolvedUrl}/v1/migrations/export/${jobId}/status/`,
    {
      headers: {
        ...authHeaders(token),
        "Vellum-Organization-Id": orgId,
      },
    },
  );

  if (response.status === 404) {
    throw new Error("Export job not found");
  }

  if (!response.ok) {
    throw new Error(
      `Export status check failed: ${response.status} ${response.statusText}`,
    );
  }

  const body = (await response.json()) as {
    status: string;
    download_url?: string;
    error?: string;
  };
  return {
    status: body.status,
    downloadUrl: body.download_url,
    error: body.error,
  };
}

export async function platformDownloadExport(
  downloadUrl: string,
): Promise<Response> {
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(
      `Download failed: ${response.status} ${response.statusText}`,
    );
  }
  return response;
}

// ---------------------------------------------------------------------------
// Migration import
// ---------------------------------------------------------------------------

export async function platformImportPreflight(
  bundleData: Uint8Array<ArrayBuffer>,
  token: string,
  orgId: string,
  platformUrl?: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const resolvedUrl = platformUrl || getPlatformUrl();
  const response = await fetch(
    `${resolvedUrl}/v1/migrations/import-preflight/`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        ...authHeaders(token),
        "Vellum-Organization-Id": orgId,
      },
      body: new Blob([bundleData]),
      signal: AbortSignal.timeout(120_000),
    },
  );

  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return { statusCode: response.status, body };
}

export async function platformImportBundle(
  bundleData: Uint8Array<ArrayBuffer>,
  token: string,
  orgId: string,
  platformUrl?: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const resolvedUrl = platformUrl || getPlatformUrl();
  const response = await fetch(`${resolvedUrl}/v1/migrations/import/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      ...authHeaders(token),
      "Vellum-Organization-Id": orgId,
    },
    body: new Blob([bundleData]),
    signal: AbortSignal.timeout(120_000),
  });

  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return { statusCode: response.status, body };
}

// ---------------------------------------------------------------------------
// Signed-URL upload flow
// ---------------------------------------------------------------------------

export async function platformRequestUploadUrl(
  token: string,
  orgId: string,
  platformUrl?: string,
): Promise<{ uploadUrl: string; bundleKey: string; expiresAt: string }> {
  const resolvedUrl = platformUrl || getPlatformUrl();
  const response = await fetch(`${resolvedUrl}/v1/migrations/upload-url/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(token),
      "Vellum-Organization-Id": orgId,
    },
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
  orgId: string,
  platformUrl?: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const resolvedUrl = platformUrl || getPlatformUrl();
  const response = await fetch(
    `${resolvedUrl}/v1/migrations/import-preflight-from-gcs/`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
        "Vellum-Organization-Id": orgId,
      },
      body: JSON.stringify({ bundle_key: bundleKey }),
      signal: AbortSignal.timeout(120_000),
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
  orgId: string,
  platformUrl?: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const resolvedUrl = platformUrl || getPlatformUrl();
  const response = await fetch(
    `${resolvedUrl}/v1/migrations/import-from-gcs/`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
        "Vellum-Organization-Id": orgId,
      },
      body: JSON.stringify({ bundle_key: bundleKey }),
      signal: AbortSignal.timeout(120_000),
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
