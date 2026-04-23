/**
 * HTTP client for the CES log export endpoint.
 *
 * Fetches a tar.gz archive of CES logs from `GET /v1/logs/export`.
 * The caller supplies configuration (base URL, service token) and an
 * optional date range filter. The response is returned as a raw
 * ArrayBuffer for the consumer to stage/extract as needed.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the CES log export client. */
export interface CesLogExportConfig {
  /** Base URL of the CES HTTP API (e.g. `http://ces-container:8090`). */
  baseUrl: string;
  /** Bearer token for authenticating with CES. */
  serviceToken: string;
}

/** Options for a log export request. */
export interface CesLogExportOptions {
  /** Start of the date range (epoch milliseconds). */
  startTime?: number;
  /** End of the date range (epoch milliseconds). */
  endTime?: number;
  /** Request timeout in milliseconds. Default: 120 000. */
  timeoutMs?: number;
}

/** Successful log export result. */
export interface CesLogExportSuccess {
  ok: true;
  /** Raw tar.gz archive bytes. */
  data: ArrayBuffer;
}

/** Failed log export result. */
export interface CesLogExportFailure {
  ok: false;
  /** Human-readable error message. */
  error: string;
}

export type CesLogExportResult = CesLogExportSuccess | CesLogExportFailure;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export async function fetchCesLogExport(
  config: CesLogExportConfig,
  options?: CesLogExportOptions,
): Promise<CesLogExportResult> {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Build query params
  const params = new URLSearchParams();
  if (options?.startTime !== undefined)
    params.set("startTime", String(options.startTime));
  if (options?.endTime !== undefined)
    params.set("endTime", String(options.endTime));
  const queryString = params.toString();
  const url = `${baseUrl}/v1/logs/export${queryString ? `?${queryString}` : ""}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.serviceToken}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return { ok: false, error: "CES log export request timed out" };
    }
    return {
      ok: false,
      error: `CES log export connection failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    return {
      ok: false,
      error: `CES log export returned ${response.status}: ${body.slice(0, 256)}`,
    };
  }

  const data = await response.arrayBuffer();
  return { ok: true, data };
}
