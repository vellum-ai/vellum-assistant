/**
 * HTTP client for posting host proxy results back to the daemon.
 *
 * Each typed POST method sends a JSON body to the corresponding daemon
 * endpoint with the required auth and client-id headers. Transfer content
 * methods handle binary GET/PUT for file transfers.
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
  gatewayPort: number;
  gatewayHost?: string;
  authToken: string;
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
  private readonly baseUrl: string;
  private authToken: string;
  private readonly fetchFn: FetchFn;

  constructor(opts: HostProxyPosterOptions) {
    const host = opts.gatewayHost ?? "127.0.0.1";
    this.baseUrl = `http://${host}:${opts.gatewayPort}`;
    this.authToken = opts.authToken;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  updateAuthToken(token: string): void {
    this.authToken = token;
  }

  // -----------------------------------------------------------------------
  // Result POST methods
  // -----------------------------------------------------------------------

  async postBashResult(result: HostBashResultPayload): Promise<boolean> {
    return this.postJson("/v1/host-bash-result", result);
  }

  async postFileResult(result: HostFileResultPayload): Promise<boolean> {
    return this.postJson("/v1/host-file-result", result);
  }

  async postTransferResult(
    result: HostTransferResultPayload,
  ): Promise<boolean> {
    return this.postJson("/v1/host-transfer-result", result);
  }

  async postBrowserResult(
    result: HostBrowserResultPayload,
  ): Promise<boolean> {
    return this.postJson("/v1/host-browser-result", result);
  }

  async postCuResult(result: HostCuResultPayload): Promise<boolean> {
    return this.postJson("/v1/host-cu-result", result);
  }

  async postAppControlResult(
    result: HostAppControlResultPayload,
  ): Promise<boolean> {
    return this.postJson("/v1/host-app-control-result", result);
  }

  // -----------------------------------------------------------------------
  // Transfer content methods
  // -----------------------------------------------------------------------

  async pullTransferContent(transferId: string): Promise<Buffer | null> {
    try {
      const url = `${this.baseUrl}/v1/transfers/${encodeURIComponent(transferId)}/content`;
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
      const url = `${this.baseUrl}/v1/transfers/${encodeURIComponent(transferId)}/content`;
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
      Authorization: `Bearer ${this.authToken}`,
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
        const res = await this.fetchFn(`${this.baseUrl}${path}`, {
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
