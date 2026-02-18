export const HEALTH_CHECK_TIMEOUT_MS = 1500;

interface HealthResponse {
  status: string;
  message?: string;
}

export interface HealthCheckResult {
  status: string;
  detail: string | null;
}

export async function checkHealth(runtimeUrl: string): Promise<HealthCheckResult> {
  try {
    const url = `${runtimeUrl}/healthz`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { status: `error (${response.status})`, detail: null };
    }

    const data = (await response.json()) as HealthResponse;
    const status = data.status || "unknown";
    return { status, detail: status !== "healthy" ? (data.message ?? null) : null };
  } catch (error) {
    const status =
      error instanceof Error && error.name === "AbortError" ? "timeout" : "unreachable";
    return { status, detail: null };
  }
}
