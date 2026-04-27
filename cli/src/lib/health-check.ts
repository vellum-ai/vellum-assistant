export const HEALTH_CHECK_TIMEOUT_MS = 1500;

interface HealthResponse {
  status: string;
  message?: string;
  version?: string;
}

export interface HealthCheckResult {
  status: string;
  detail: string | null;
  version?: string;
}

export async function checkManagedHealth(
  runtimeUrl: string,
  assistantId: string,
): Promise<HealthCheckResult> {
  const { readPlatformToken } = await import("./platform-client.js");
  const token = readPlatformToken();
  if (!token) {
    return {
      status: "error (auth)",
      detail: "not logged in — run `vellum login`",
    };
  }

  let headers: Record<string, string>;
  try {
    const { authHeaders } = await import("./platform-client.js");
    headers = await authHeaders(token, runtimeUrl);
  } catch (err) {
    return {
      status: "error (auth)",
      detail: err instanceof Error ? err.message : "org lookup failed",
    };
  }

  try {
    const url = `${runtimeUrl}/v1/assistants/${encodeURIComponent(assistantId)}/healthz/`;
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      HEALTH_CHECK_TIMEOUT_MS,
    );

    const response = await fetch(url, {
      signal: controller.signal,
      headers,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { status: `error (${response.status})`, detail: null };
    }

    const data = (await response.json()) as HealthResponse;
    const status = data.status || "unknown";
    return {
      status,
      detail: status !== "healthy" ? (data.message ?? null) : null,
      version: data.version,
    };
  } catch (error) {
    const status =
      error instanceof Error && error.name === "AbortError"
        ? "timeout"
        : "unreachable";
    return { status, detail: null };
  }
}

export interface ManagedProcessEntry {
  name: string;
  status: "running" | "not_running" | "unreachable";
  children?: ManagedProcessEntry[];
  info?: string;
}

export interface ManagedPsResponse {
  processes: ManagedProcessEntry[];
}

export async function fetchManagedPs(
  runtimeUrl: string,
  assistantId: string,
): Promise<ManagedPsResponse | null> {
  const { readPlatformToken, authHeaders } =
    await import("./platform-client.js");
  const token = readPlatformToken();
  if (!token) return null;

  let headers: Record<string, string>;
  try {
    headers = await authHeaders(token, runtimeUrl);
  } catch {
    return null;
  }

  // Try the /ps endpoint first; fall back to legacy /connection-status
  // for platform versions that haven't rolled it out yet.
  try {
    const psUrl = `${runtimeUrl}/v1/assistants/${encodeURIComponent(assistantId)}/ps/`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(psUrl, {
      signal: controller.signal,
      headers,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      return (await response.json()) as ManagedPsResponse;
    }

    // /ps not available — fall back to legacy connection-status
    if (response.status === 404 || response.status === 405) {
      return fetchLegacyConnectionStatus(runtimeUrl, assistantId, headers);
    }

    return null;
  } catch {
    return null;
  }
}

interface LegacyConnectionStatus {
  state: string;
  is_awake: boolean;
  pod_status: string | null;
  detail: string | null;
}

async function fetchLegacyConnectionStatus(
  runtimeUrl: string,
  assistantId: string,
  headers: Record<string, string>,
): Promise<ManagedPsResponse | null> {
  try {
    const url = `${runtimeUrl}/v1/assistants/${encodeURIComponent(assistantId)}/connection-status/`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers,
    });

    clearTimeout(timeoutId);
    if (!response.ok) return null;

    const data = (await response.json()) as LegacyConnectionStatus;

    // Translate legacy shape into the ps process tree
    const status: ManagedProcessEntry["status"] = data.is_awake
      ? "running"
      : "not_running";
    return {
      processes: [
        { name: "assistant", status, info: data.detail ?? undefined },
      ],
    };
  } catch {
    return null;
  }
}

export async function checkHealth(
  runtimeUrl: string,
  bearerToken?: string,
): Promise<HealthCheckResult> {
  try {
    const url = `${runtimeUrl}/v1/health`;
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      HEALTH_CHECK_TIMEOUT_MS,
    );

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (bearerToken) {
      headers["Authorization"] = `Bearer ${bearerToken}`;
    }

    const response = await fetch(url, {
      signal: controller.signal,
      headers,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { status: `error (${response.status})`, detail: null };
    }

    const data = (await response.json()) as HealthResponse;
    const status = data.status || "unknown";
    return {
      status,
      detail: status !== "healthy" ? (data.message ?? null) : null,
      version: data.version,
    };
  } catch (error) {
    const status =
      error instanceof Error && error.name === "AbortError"
        ? "timeout"
        : "unreachable";
    return { status, detail: null };
  }
}
