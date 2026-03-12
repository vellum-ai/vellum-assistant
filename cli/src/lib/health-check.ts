export const HEALTH_CHECK_TIMEOUT_MS = 1500;

interface HealthResponse {
  status: string;
  message?: string;
}

export interface HealthCheckResult {
  status: string;
  detail: string | null;
}

interface OrgListResponse {
  results: { id: string }[];
}

async function fetchOrganizationId(
  platformUrl: string,
  token: string,
): Promise<{ orgId: string } | { error: string }> {
  try {
    const response = await fetch(`${platformUrl}/v1/organizations/`, {
      headers: { "X-Session-Token": token },
    });
    if (!response.ok) {
      return { error: `org lookup failed (${response.status})` };
    }
    const body = (await response.json()) as OrgListResponse;
    const orgId = body.results?.[0]?.id;
    if (!orgId) {
      return { error: "no organization found" };
    }
    return { orgId };
  } catch {
    return { error: "org lookup unreachable" };
  }
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

  const orgResult = await fetchOrganizationId(runtimeUrl, token);
  if ("error" in orgResult) {
    return {
      status: "error (auth)",
      detail: orgResult.error,
    };
  }
  const { orgId } = orgResult;

  try {
    const url = `${runtimeUrl}/v1/assistants/${encodeURIComponent(assistantId)}/healthz/`;
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      HEALTH_CHECK_TIMEOUT_MS,
    );

    const headers: Record<string, string> = {
      "X-Session-Token": token,
      "Vellum-Organization-Id": orgId,
    };

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
    };
  } catch (error) {
    const status =
      error instanceof Error && error.name === "AbortError"
        ? "timeout"
        : "unreachable";
    return { status, detail: null };
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
    };
  } catch (error) {
    const status =
      error instanceof Error && error.name === "AbortError"
        ? "timeout"
        : "unreachable";
    return { status, detail: null };
  }
}
