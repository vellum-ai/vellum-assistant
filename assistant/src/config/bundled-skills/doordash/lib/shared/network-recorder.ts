/**
 * CDP Network recorder for capturing browser network traffic.
 * Inlined from assistant/src/tools/browser/network-recorder.ts
 */

import type {
  ExtractedCredential,
  NetworkRecordedEntry,
  NetworkRecordedRequest,
} from "./recording-types.js";

/** Max response body size to capture (64 KB). */
const MAX_BODY_SIZE = 64 * 1024;

/** CDP endpoint to discover targets. */
const CDP_BASE = "http://localhost:9222";

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
        } catch {
          /* ignore parse errors */
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
  private cdpBaseUrl = CDP_BASE;
  private attachedTargetIds = new Set<string>();
  private targetPollTimer?: ReturnType<typeof setInterval>;

  onLoginDetected?: () => void;
  loginSignals: string[] = [];

  get entryCount(): number {
    return this.entries.size;
  }

  constructor(targetDomain?: string) {
    this.targetDomain = targetDomain;
  }

  async startDirect(cdpBaseUrl: string = CDP_BASE): Promise<void> {
    if (this.running) return;
    this.cdpBaseUrl = cdpBaseUrl;

    const versionRes = await fetch(`${cdpBaseUrl}/json/version`);
    const version = (await versionRes.json()) as {
      webSocketDebuggerUrl: string;
    };
    const wsUrl = version.webSocketDebuggerUrl;

    if (!wsUrl) {
      throw new Error("Chrome CDP: no webSocketDebuggerUrl found");
    }

    this.cdp = new DirectCDPClient();
    await this.cdp.connect(wsUrl);
    this.running = true;

    await this.discoverAndAttachTargets();

    this.targetPollTimer = setInterval(() => {
      this.discoverAndAttachTargets().catch(() => {});
    }, 2000);
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
          } catch {
            this.attachedTargetIds.delete(page.id);
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

    if (this.targetPollTimer) {
      clearInterval(this.targetPollTimer);
      this.targetPollTimer = undefined;
    }

    for (const client of this.pageClients) {
      try {
        await client.send("Network.disable");
      } catch {
        /* ignore */
      }
      client.close();
    }
    this.pageClients = [];

    if (this.cdp) {
      this.cdp.close();
      this.cdp = null;
    }

    const result = Array.from(this.entries.values());
    this.entries.clear();
    this.attachedTargetIds.clear();
    this.loginDetectedFired = false;
    return result;
  }

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
    } catch {
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

    if (
      status === 200 &&
      this.onLoginDetected &&
      !this.loginDetectedFired &&
      this.loginSignals.length > 0 &&
      this.loginSignals.some((sig) => entry.request.url.includes(sig))
    ) {
      this.loginDetectedFired = true;
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
