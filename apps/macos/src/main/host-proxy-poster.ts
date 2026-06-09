/**
 * HTTP client for posting host proxy results back to the daemon.
 *
 * Each typed POST method sends a JSON body to the corresponding endpoint
 * with the required auth and client-id headers. Transfer content methods
 * handle binary GET/PUT for file transfers.
 *
 * Supports both local gateway connections (loopback) and cloud/platform
 * connections (assistant-scoped URLs) — the caller provides an endpoint
 * base and an auth-headers builder.
 *
 * Injectable fetch function for testability (mirrors the SSE client pattern).
 * Returns boolean success/failure without throwing.
 */

import { getDeviceId } from "./device-id";

// ---------------------------------------------------------------------------
// Payload interfaces — match the daemon route request bodies
// ---------------------------------------------------------------------------

export interface HostBashResultPayload {
  requestId: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
}

export interface HostFileResultPayload {
  requestId: string;
  content?: string;
  isError?: boolean;
  imageData?: string;
  audioData?: string;
  audioMimeType?: string;
}

export interface HostTransferResultPayload {
  requestId: string;
  isError?: boolean;
  bytesWritten?: number;
  errorMessage?: string;
}

export interface HostBrowserResultPayload {
  requestId: string;
  content?: string;
  isError?: boolean;
}

export interface HostCuResultPayload {
  requestId: string;
  axTree?: string;
  axDiff?: string;
  screenshot?: string;
  screenshotWidthPx?: number;
  screenshotHeightPx?: number;
  screenWidthPt?: number;
  screenHeightPt?: number;
  executionResult?: string;
  executionError?: string;
  secondaryWindows?: string;
  userGuidance?: string;
}

export type HostAppControlState = "running" | "missing" | "minimized";

export interface HostAppControlResultPayload {
  requestId: string;
  state: HostAppControlState;
  pngBase64?: string;
  windowBounds?: { x: number; y: number; width: number; height: number };
  executionResult?: string;
  executionError?: string;
}

// ---------------------------------------------------------------------------
// Fetch type — matches the subset of globalThis.fetch we use
// ---------------------------------------------------------------------------

type FetchFn = typeof globalThis.fetch;

// ---------------------------------------------------------------------------
// HostProxyPoster
// ---------------------------------------------------------------------------

export interface HostProxyPosterOptions {
  /**
   * Base URL including the path prefix for result endpoints.
   * Local: "http://127.0.0.1:{port}/v1"
   * Cloud: "{runtimeUrl}/v1/assistants/{id}"
   */
  endpointBase: string;
  /** Called on every request to build auth headers. */
  authHeaders: () => Record<string, string>;
  /** Override fetch for testing. Defaults to globalThis.fetch. */
  fetch?: FetchFn;
}

/** Minimum timeout in milliseconds. */
const MIN_TIMEOUT_MS = 30_000;
/** Extra timeout per megabyte of payload. */
const TIMEOUT_PER_MB_MS = 5_000;

/**
 * Compute a timeout that scales with payload size: 30s floor + 5s per MB.
 */
function computeTimeout(bodyBytes: number): number {
  const mbPortion = Math.ceil(bodyBytes / (1024 * 1024)) * TIMEOUT_PER_MB_MS;
  return MIN_TIMEOUT_MS + mbPortion;
}

export class HostProxyPoster {
  private readonly endpointBase: string;
  private readonly authHeaders: () => Record<string, string>;
  private readonly fetchFn: FetchFn;

  constructor(opts: HostProxyPosterOptions) {
    this.endpointBase = opts.endpointBase;
    this.authHeaders = opts.authHeaders;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  // -----------------------------------------------------------------------
  // Result POST methods
  // -----------------------------------------------------------------------

  async postBashResult(result: HostBashResultPayload): Promise<boolean> {
    return this.postJson("/host-bash-result", result);
  }

  async postFileResult(result: HostFileResultPayload): Promise<boolean> {
    return this.postJson("/host-file-result", result);
  }

  async postTransferResult(
    result: HostTransferResultPayload,
  ): Promise<boolean> {
    return this.postJson("/host-transfer-result", result);
  }

  async postBrowserResult(
    result: HostBrowserResultPayload,
  ): Promise<boolean> {
    return this.postJson("/host-browser-result", result);
  }

  async postCuResult(result: HostCuResultPayload): Promise<boolean> {
    return this.postJson("/host-cu-result", result);
  }

  async postAppControlResult(
    result: HostAppControlResultPayload,
  ): Promise<boolean> {
    return this.postJson("/host-app-control-result", result);
  }

  // -----------------------------------------------------------------------
  // Transfer content methods
  // -----------------------------------------------------------------------

  async pullTransferContent(transferId: string): Promise<Buffer | null> {
    try {
      const url = `${this.endpointBase}/transfers/${encodeURIComponent(transferId)}/content`;
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        MIN_TIMEOUT_MS,
      );
      try {
        const res = await this.fetchFn(url, {
          method: "GET",
          headers: this.commonHeaders(),
          signal: controller.signal,
        });
        if (!res.ok) return null;
        const arrayBuf = await res.arrayBuffer();
        return Buffer.from(arrayBuf);
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return null;
    }
  }

  async pushTransferContent(
    transferId: string,
    data: Buffer,
    sha256: string,
  ): Promise<boolean> {
    try {
      const url = `${this.endpointBase}/transfers/${encodeURIComponent(transferId)}/content`;
      const timeout = computeTimeout(data.length);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const headers = this.commonHeaders();
        headers["Content-Type"] = "application/octet-stream";
        headers["X-Transfer-SHA256"] = sha256;
        const res = await this.fetchFn(url, {
          method: "PUT",
          headers,
          body: data,
          signal: controller.signal,
        });
        return res.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private commonHeaders(): Record<string, string> {
    return {
      ...this.authHeaders(),
      "X-Vellum-Client-Id": getDeviceId(),
    };
  }

  private async postJson(
    path: string,
    payload: object,
  ): Promise<boolean> {
    try {
      const body = JSON.stringify(payload);
      const timeout = computeTimeout(Buffer.byteLength(body, "utf-8"));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const headers = this.commonHeaders();
        headers["Content-Type"] = "application/json";
        const res = await this.fetchFn(`${this.endpointBase}${path}`, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
        return res.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }
}
