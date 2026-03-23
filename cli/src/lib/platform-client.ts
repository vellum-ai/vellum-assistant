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

const DEFAULT_PLATFORM_URL = "";

function getXdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
}

function getPlatformTokenPath(): string {
  return join(getXdgConfigHome(), "vellum", "platform-token");
}

export function getPlatformUrl(): string {
  return process.env.VELLUM_PLATFORM_URL ?? DEFAULT_PLATFORM_URL;
}

/**
 * Returns the platform URL, throwing a clear error if it is not configured.
 * Use this in functions that need a valid URL to make HTTP requests.
 */
function requirePlatformUrl(): string {
  const url = getPlatformUrl();
  if (!url) {
    throw new Error(
      "VELLUM_PLATFORM_URL is not configured. Set it in your environment or .env file.",
    );
  }
  return url;
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

export interface PlatformUser {
  id: string;
  email: string;
  display: string;
}

interface OrganizationListResponse {
  results: { id: string; name: string }[];
}

export async function fetchOrganizationId(token: string): Promise<string> {
  const platformUrl = requirePlatformUrl();
  const url = `${platformUrl}/v1/organizations/`;
  const response = await fetch(url, {
    headers: { "X-Session-Token": token },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch organizations from ${platformUrl} (${response.status}). Try logging in again.`,
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

export async function fetchCurrentUser(token: string): Promise<PlatformUser> {
  const url = `${requirePlatformUrl()}/_allauth/app/v1/auth/session`;
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

interface RollbackResponse {
  detail: string;
  version: string | null;
}

export async function rollbackPlatformAssistant(
  token: string,
  orgId: string,
  version?: string,
): Promise<{ detail: string; version: string | null }> {
  const platformUrl = requirePlatformUrl();
  const response = await fetch(`${platformUrl}/v1/assistants/rollback/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": token,
      "Vellum-Organization-Id": orgId,
    },
    body: JSON.stringify(version ? { version } : {}),
  });

  const body = (await response.json()) as RollbackResponse & {
    detail?: string;
  };

  if (response.status === 200) {
    return { detail: body.detail, version: body.version };
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
): Promise<{ jobId: string; status: string }> {
  const platformUrl = requirePlatformUrl();
  const response = await fetch(`${platformUrl}/v1/migrations/export/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": token,
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
): Promise<{ status: string; downloadUrl?: string; error?: string }> {
  const platformUrl = requirePlatformUrl();
  const response = await fetch(
    `${platformUrl}/v1/migrations/export/${jobId}/status/`,
    {
      headers: {
        "X-Session-Token": token,
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
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const platformUrl = requirePlatformUrl();
  const response = await fetch(
    `${platformUrl}/v1/migrations/import-preflight/`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Session-Token": token,
        "Vellum-Organization-Id": orgId,
      },
      body: new Blob([bundleData]),
      signal: AbortSignal.timeout(120_000),
    },
  );

  const body = (await response.json()) as Record<string, unknown>;
  return { statusCode: response.status, body };
}

export async function platformImportBundle(
  bundleData: Uint8Array<ArrayBuffer>,
  token: string,
  orgId: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const platformUrl = requirePlatformUrl();
  const response = await fetch(`${platformUrl}/v1/migrations/import/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Session-Token": token,
      "Vellum-Organization-Id": orgId,
    },
    body: new Blob([bundleData]),
    signal: AbortSignal.timeout(120_000),
  });

  const body = (await response.json()) as Record<string, unknown>;
  return { statusCode: response.status, body };
}
