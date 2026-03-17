/**
 * CDP Network recorder.
 *
 * Connects directly to Chrome's CDP WebSocket endpoint to record
 * Network.* events across all tabs the user browses.
 */

import { getLogger } from "../../util/logger.js";
import { truncate } from "../../util/truncate.js";
import type {
  ExtractedCredential,
  NetworkRecordedEntry,
  NetworkRecordedRequest,
} from "./network-recording-types.js";

const log = getLogger("network-recorder");

/** Max response body size to capture (64 KB). */
const MAX_BODY_SIZE = 64 * 1024;

/** Default CDP endpoint - used when no base URL is injected. */
const DEFAULT_CDP_BASE = "http://localhost:9222";

/**
 * Minimal CDP client over WebSocket - talks the Chrome DevTools Protocol directly
 * without needing Playwright, so it can attach to the user's real browsing session.
 */
class DirectCDPClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private callbacks = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private eventHandlers = new Map<
    string,
    Array<(params: Record<string, unknown>) => void>
  >();

  async connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        this.ws = ws;
        resolve();
      };
      ws.onerror = (e) => reject(new Error(`CDP WebSocket error: ${e}`));
      ws.onclose = () => {
        this.ws = null;
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(
            typeof event.data === "string" ? event.data : "",
          );
          if (msg.id != null) {
            const cb = this.callbacks.get(msg.id);
            if (cb) {
              this.callbacks.delete(msg.id);
              if (msg.error) {
                cb.reject(new Error(msg.error.message));
              } else {
                cb.resolve(msg.result);
              }
            }
          } else if (msg.method) {
            const handlers = this.eventHandlers.get(msg.method);
            if (handlers) {
              for (const h of handlers) h(msg.params ?? {});
            }
          }
        } catch (e) {
          log.debug({ err: e }, "Failed to parse CDP WebSocket message");
        }
      };
    });
  }

  async send(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.ws) throw new Error("Not connected");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, handler: (params: Record<string, unknown>) => void): void {
    let handlers = this.eventHandlers.get(event);
    if (!handlers) {
      handlers = [];
      this.eventHandlers.set(event, handlers);
    }
    handlers.push(handler);
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    for (const cb of this.callbacks.values()) {
      cb.reject(new Error("CDP client closed"));
    }
    this.callbacks.clear();
    this.eventHandlers.clear();
  }
}

export class NetworkRecorder {
  private cdp: DirectCDPClient | null = null;
  private entries = new Map<string, NetworkRecordedEntry>();
  private targetDomain?: string;
  private running = false;
  private cdpBaseUrl = DEFAULT_CDP_BASE;
  private attachedTargetIds = new Set<string>();
  private targetPollTimer?: ReturnType<typeof setInterval>;

  /** Called when a successful login-indicating response is detected. */
  onLoginDetected?: () => void;

  /** URL patterns that indicate a successful login (checked via `includes`). */
  loginSignals: string[] = [];

  /** Number of network entries recorded so far. */
  get entryCount(): number {
    return this.entries.size;
  }

  constructor(targetDomain?: string, cdpBaseUrl?: string) {
    this.targetDomain = targetDomain;
    if (cdpBaseUrl) this.cdpBaseUrl = cdpBaseUrl;
  }

  /**
   * Connect directly to Chrome's CDP endpoint and start recording network events.
   * Attaches to the browser-level target so events from all tabs are captured.
   */
  async startDirect(cdpBaseUrl?: string): Promise<void> {
    if (this.running) return;
    if (cdpBaseUrl) this.cdpBaseUrl = cdpBaseUrl;

    // Discover the browser's WebSocket debugger URL
    const versionRes = await fetch(`${this.cdpBaseUrl}/json/version`);
    const version = (await versionRes.json()) as {
      webSocketDebuggerUrl: string;
    };
    const wsUrl = version.webSocketDebuggerUrl;

    if (!wsUrl) {
      throw new Error("Chrome CDP: no webSocketDebuggerUrl found");
    }

    log.info({ wsUrl }, "Connecting to Chrome CDP");
    this.cdp = new DirectCDPClient();
    await this.cdp.connect(wsUrl);
    this.running = true;

    // Attach to all existing page targets
    await this.discoverAndAttachTargets();

    // Poll for new tabs every 2 seconds so we catch tabs opened after recording starts
    this.targetPollTimer = setInterval(() => {
      this.discoverAndAttachTargets().catch((err) => {
        log.debug({ err }, "Target discovery poll failed");
      });
    }, 2000);

    log.info(
      {
        targetDomain: this.targetDomain,
        attachedCount: this.attachedTargetIds.size,
      },
      "Network recording started",
    );
  }

  private async discoverAndAttachTargets(): Promise<void> {
    if (!this.running) return;
    try {
      const res = await fetch(`${this.cdpBaseUrl}/json`);
      const pages = (await res.json()) as Array<{
        id: string;
        type: string;
        webSocketDebuggerUrl: string;
      }>;

      for (const page of pages) {
        if (
          page.type === "page" &&
          page.webSocketDebuggerUrl &&
          !this.attachedTargetIds.has(page.id)
        ) {
          try {
            this.attachedTargetIds.add(page.id);
            await this.attachToTarget(page.webSocketDebuggerUrl);
            log.info({ targetId: page.id }, "Attached to new tab");
          } catch (err) {
            this.attachedTargetIds.delete(page.id);
            log.warn(
              { err, targetId: page.id },
              "Failed to attach to page target",
            );
          }
        }
      }
    } catch {
      // CDP endpoint may be temporarily unavailable
    }
  }

  private pageClients: DirectCDPClient[] = [];

  private async attachToTarget(wsUrl: string): Promise<void> {
    const client = new DirectCDPClient();
    await client.connect(wsUrl);

    client.on("Network.requestWillBeSent", (params) =>
      this.handleRequestWillBeSent(params),
    );
    client.on("Network.responseReceived", (params) =>
      this.handleResponseReceived(params),
    );
    client.on("Network.loadingFinished", (params) =>
      this.handleLoadingFinished(params, client),
    );

    await client.send("Network.enable");
    this.pageClients.push(client);
  }

  async stop(): Promise<NetworkRecordedEntry[]> {
    if (!this.running) return [];
    this.running = false;

    // Stop polling for new tabs
    if (this.targetPollTimer) {
      clearInterval(this.targetPollTimer);
      this.targetPollTimer = undefined;
    }

    // Close all page-level CDP connections
    for (const client of this.pageClients) {
      try {
        await client.send("Network.disable");
      } catch (e) {
        log.debug({ err: e }, "Network.disable failed during cleanup");
      }
      client.close();
    }
    this.pageClients = [];

    // Close browser-level connection
    if (this.cdp) {
      this.cdp.close();
      this.cdp = null;
    }

    const result = Array.from(this.entries.values());
    this.entries.clear();
    this.attachedTargetIds.clear();
    this.loginDetectedFired = false;
    log.info({ entryCount: result.length }, "Network recording stopped");
    return result;
  }

  /**
   * Extract cookies via CDP Network.getAllCookies on the first page client.
   */
  async extractCookies(domain?: string): Promise<ExtractedCredential[]> {
    const client = this.pageClients[0];
    if (!client) return [];
    try {
      const result = (await client.send("Network.getAllCookies")) as {
        cookies: Array<{
          name: string;
          value: string;
          domain: string;
          path: string;
          httpOnly: boolean;
          secure: boolean;
          expires: number;
        }>;
      };
      let cookies = result.cookies ?? [];
      if (domain) {
        cookies = cookies.filter(
          (c) =>
            c.domain === domain ||
            c.domain === `.${domain}` ||
            c.domain.endsWith(`.${domain}`),
        );
      }
      return cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        httpOnly: c.httpOnly,
        secure: c.secure,
        expires: c.expires > 0 ? c.expires : undefined,
      }));
    } catch (err) {
      log.warn({ err }, "Failed to extract cookies");
      return [];
    }
  }

  getEntries(): NetworkRecordedEntry[] {
    return Array.from(this.entries.values());
  }

  private matchesDomain(url: string): boolean {
    if (!this.targetDomain) return true;
    try {
      const hostname = new URL(url).hostname;
      return (
        hostname === this.targetDomain ||
        hostname.endsWith(`.${this.targetDomain}`)
      );
    } catch {
      return false;
    }
  }

  private loginDetectedFired = false;

  private handleRequestWillBeSent(params: Record<string, unknown>): void {
    const resourceType = params.type as string;
    if (resourceType !== "XHR" && resourceType !== "Fetch") return;

    const request = params.request as Record<string, unknown>;
    const url = request.url as string;
    if (!this.matchesDomain(url)) return;

    const requestId = params.requestId as string;
    const headers = (request.headers as Record<string, string>) ?? {};
    const method = (request.method as string) ?? "GET";
    const postData = request.postData as string | undefined;

    log.debug(
      { url: truncate(url, 120, ""), method, requestId },
      "Request captured",
    );

    const recordedRequest: NetworkRecordedRequest = {
      method,
      url,
      headers,
      postData,
    };
    const entry: NetworkRecordedEntry = {
      requestId,
      resourceType,
      timestamp: (params.timestamp as number) ?? Date.now() / 1000,
      request: recordedRequest,
    };
    this.entries.set(requestId, entry);
  }

  private handleResponseReceived(params: Record<string, unknown>): void {
    const requestId = params.requestId as string;
    const entry = this.entries.get(requestId);
    if (!entry) return;

    const response = params.response as Record<string, unknown>;
    const status = (response.status as number) ?? 0;
    entry.response = {
      status,
      headers: (response.headers as Record<string, string>) ?? {},
      mimeType: (response.mimeType as string) ?? "",
    };

    // Auto-detect login: check for any of the login signal URLs
    if (
      status === 200 &&
      this.onLoginDetected &&
      !this.loginDetectedFired &&
      this.loginSignals.length > 0 &&
      this.loginSignals.some((sig) => entry.request.url.includes(sig))
    ) {
      this.loginDetectedFired = true;
      log.info(
        { url: truncate(entry.request.url, 120, "") },
        "Login detected - will auto-stop in 5s",
      );
      // Delay to let remaining network requests (cookies, session data) settle
      setTimeout(() => this.onLoginDetected?.(), 5000);
    }
  }

  private handleLoadingFinished(
    params: Record<string, unknown>,
    client: DirectCDPClient,
  ): void {
    const requestId = params.requestId as string;
    const entry = this.entries.get(requestId);
    if (!entry || !entry.response) return;

    const mimeType = entry.response.mimeType;
    if (!mimeType.includes("json") && !mimeType.includes("text")) return;

    this.fetchResponseBody(requestId, entry, client);
  }

  private async fetchResponseBody(
    requestId: string,
    entry: NetworkRecordedEntry,
    client: DirectCDPClient,
  ): Promise<void> {
    if (!this.running) return;
    try {
      const result = (await client.send("Network.getResponseBody", {
        requestId,
      })) as {
        body: string;
        base64Encoded: boolean;
      };

      if (result.body && entry.response) {
        const body = result.base64Encoded
          ? Buffer.from(result.body, "base64").toString("utf-8")
          : result.body;

        entry.response.body =
          body.length > MAX_BODY_SIZE
            ? body.slice(0, MAX_BODY_SIZE) + "...[truncated]"
            : body;
      }
    } catch {
      // Response body may not be available
    }
  }
}
