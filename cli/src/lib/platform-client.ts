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
    headers: { "X-Session-Token": token },
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
      "X-Session-Token": token,
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
  platformUrl?: string,
): Promise<{ status: string; downloadUrl?: string; error?: string }> {
  const resolvedUrl = platformUrl || getPlatformUrl();
  const response = await fetch(
    `${resolvedUrl}/v1/migrations/export/${jobId}/status/`,
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
  platformUrl?: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const resolvedUrl = platformUrl || getPlatformUrl();
  const response = await fetch(
    `${resolvedUrl}/v1/migrations/import-preflight/`,
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
      "X-Session-Token": token,
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
