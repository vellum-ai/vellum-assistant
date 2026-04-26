/**
 * SSE connection helper for vellum-cloud assistants.
 *
 * Manages the connect/reconnect lifecycle for the cloud transport:
 * GET /v1/assistants/{assistantId}/events?conversationKey=...
 *
 * The class opens a `fetch()` SSE stream, parses `data:` frames,
 * and forwards unwrapped event payloads to the caller via `onMessage`.
 * It handles reconnection with exponential backoff on unexpected closes.
 *
 * Client registration headers (`X-Vellum-Client-Id`,
 * `X-Vellum-Interface-Id`) are sent on every connect so the daemon's
 * ClientRegistry tracks this extension instance.
 */

import { getClientRegistrationHeaders } from './client-identity.js';

/** Reconnect backoff bounds for transient SSE disconnects. */
const SSE_RECONNECT_BASE_MS = 1_000;
const SSE_RECONNECT_MAX_MS = 30_000;

/**
 * Connection mode for cloud assistants. The `runtimeUrl` is the
 * gateway base URL (e.g. `https://api.vellum.ai`); the `token` is the
 * bearer token for the gateway edge auth (WorkOS session JWT).
 */
export type SseMode = {
  kind: 'vellum-cloud';
  runtimeUrl: string;
  assistantId: string;
  token: string | null;
  organizationId: string | null;
};

export interface SseConnectionDeps {
  mode: SseMode;
  /** Invoked with the raw JSON-parsed event payload for each SSE data frame. */
  onMessage: (data: unknown) => void;
  /** Invoked when the SSE stream opens successfully. */
  onOpen: () => void;
  /**
   * Invoked when the SSE stream closes. `authError` is set when the
   * connection failed due to authentication issues (401/403).
   */
  onClose: (authError?: string) => void;
  /**
   * Invoked when the SSE endpoint returns 404 — the selected assistant
   * no longer exists. The worker should re-validate and recover.
   * If not provided, 404 is treated as a generic reconnectable error.
   */
  onNotFound?: () => void;
}

/**
 * Long-lived SSE stream helper. One instance per live cloud session.
 */
export class SseConnection {
  private deps: SseConnectionDeps;
  private abortController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = SSE_RECONNECT_BASE_MS;
  private closedByCaller = false;
  private _isOpen = false;

  constructor(deps: SseConnectionDeps) {
    this.deps = deps;
  }

  /** Is the SSE stream currently open and receiving events? */
  isOpen(): boolean {
    return this._isOpen;
  }

  /** Return the current connection mode (e.g. for building result POSTs). */
  getMode(): SseMode {
    return this.deps.mode;
  }

  /** Begin (or resume) connecting. */
  start(): void {
    this.closedByCaller = false;
    this.reconnectDelay = SSE_RECONNECT_BASE_MS;
    void this.connect();
  }

  /**
   * Close the SSE stream permanently. After this the connection will
   * not reconnect; call `start()` again to resume.
   */
  close(): void {
    this.closedByCaller = true;
    this._isOpen = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /**
   * Update the mode (e.g. refreshed token) without destroying the instance.
   */
  setMode(mode: SseMode): void {
    this.deps = { ...this.deps, mode };
    this.close();
    this.start();
  }

  // ── Internals ─────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    if (this._isOpen || this.closedByCaller) return;

    const { mode } = this.deps;
    const baseUrl = mode.runtimeUrl.replace(/\/$/, '');
    const url = `${baseUrl}/v1/assistants/${encodeURIComponent(mode.assistantId)}/events`;

    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      ...(await getClientRegistrationHeaders()),
    };
    if (mode.token) {
      headers['Authorization'] = `Bearer ${mode.token}`;
    }
    if (mode.organizationId) {
      headers['Vellum-Organization-Id'] = mode.organizationId;
    }

    const ac = new AbortController();
    this.abortController = ac;

    let response: Response;
    try {
      response = await fetch(url, {
        headers,
        signal: ac.signal,
        credentials: 'include',
      });
    } catch {
      if (this.closedByCaller || ac.signal.aborted) return;
      this.deps.onClose();
      this.scheduleReconnect();
      return;
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        const body = await response.text().catch(() => '');
        this._isOpen = false;
        this.deps.onClose(
          body || `Authentication failed (${response.status}). Sign in again to reconnect.`,
        );
        return;
      }
      if (response.status === 404 && this.deps.onNotFound) {
        // The assistant no longer exists — stop reconnecting and let
        // the worker handle recovery (re-validate, switch, or show picker).
        this._isOpen = false;
        this.deps.onNotFound();
        return;
      }
      // Other errors: notify the worker so health state transitions
      // (e.g. connected → reconnecting), then schedule a retry.
      this.deps.onClose();
      this.scheduleReconnect();
      return;
    }

    if (!response.body) {
      this.deps.onClose();
      this.scheduleReconnect();
      return;
    }

    this._isOpen = true;
    this.reconnectDelay = SSE_RECONNECT_BASE_MS;
    this.deps.onOpen();

    // Read the SSE stream
    try {
      await this.readStream(response.body);
    } catch {
      // Stream ended or errored
    }

    this._isOpen = false;
    if (!this.closedByCaller) {
      this.deps.onClose();
      this.scheduleReconnect();
    }
  }

  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (this.closedByCaller) break;

        buffer += decoder.decode(value, { stream: true });

        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          // Skip empty frames and heartbeat comments
          if (!frame.trim() || frame.startsWith(':')) continue;

          const dataLines: string[] = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('data: ')) {
              dataLines.push(line.slice(6));
            } else if (line === 'data') {
              dataLines.push('');
            }
          }
          if (dataLines.length === 0) continue;
          const data = dataLines.join('\n');

          try {
            const parsed = JSON.parse(data);
            this.deps.onMessage(parsed);
          } catch {
            // Skip malformed JSON
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByCaller || this.reconnectTimer !== null) return;
    const delay = this.reconnectDelay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByCaller) {
        void this.connect();
      }
    }, delay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, SSE_RECONNECT_MAX_MS);
  }
}
