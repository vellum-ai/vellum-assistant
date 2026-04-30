import { Buffer } from "node:buffer";
import type { OutgoingHttpHeaders } from "node:http";

import type { GatewayConfig } from "../config.js";
import type { ConfigFileCache } from "../config-file-cache.js";
import type { CredentialCache } from "../credential-cache.js";
import { credentialKey } from "../credential-key.js";
import {
  enqueueConfigWrite,
  readConfigFile,
  writeConfigFileAtomic,
} from "../http/routes/config-file-utils.js";
import { getLogger } from "../logger.js";
import { bridgeVelayHttpRequest } from "./http-bridge.js";
import {
  VELAY_FRAME_TYPES,
  VELAY_TUNNEL_SUBPROTOCOL,
  type VelayFrame,
  type VelayHttpRequestFrame,
  type VelayRegisteredFrame,
  type VelayWebSocketInboundFrame,
} from "./protocol.js";
import { VelayWebSocketBridge } from "./websocket-bridge.js";

const log = getLogger("velay-client");

const BASE_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 30_000;
const RECONNECT_JITTER_RATIO = 0.5;

export type WebSocketConstructorWithOptions = {
  new (
    url: string | URL,
    options?: {
      protocols?: string | string[];
      headers?: OutgoingHttpHeaders;
    },
  ): WebSocket;
};

export type VelayTunnelClientOptions = {
  velayBaseUrl: string;
  gatewayLoopbackBaseUrl: string;
  credentials: CredentialCache;
  configFile: ConfigFileCache;
  webSocketConstructor?: WebSocketConstructorWithOptions;
  httpBridge?: typeof bridgeVelayHttpRequest;
  webSocketBridgeFactory?: (
    gatewayLoopbackBaseUrl: string,
    sendFrame: (frame: VelayFrame) => void,
  ) => VelayWebSocketBridge;
  reconnect?: {
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitterRatio?: number;
    random?: () => number;
  };
  timerApi?: TimerApi;
};

export type TimerApi = {
  setTimeout: (fn: () => void, delayMs: number) => unknown;
  clearTimeout: (timer: unknown) => void;
};

export class VelayTunnelClient {
  private readonly webSocketConstructor: WebSocketConstructorWithOptions;
  private readonly httpBridge: typeof bridgeVelayHttpRequest;
  private readonly webSocketBridge: VelayWebSocketBridge;
  private readonly baseReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly reconnectJitterRatio: number;
  private readonly random: () => number;
  private readonly timerApi: TimerApi;
  private ws: WebSocket | null = null;
  private running = false;
  private connecting = false;
  private reconnectAttempt = 0;
  private reconnectTimer: unknown = null;
  private publishedTwilioPublicBaseUrl: string | undefined;

  constructor(private readonly options: VelayTunnelClientOptions) {
    this.webSocketConstructor =
      options.webSocketConstructor ??
      (WebSocket as unknown as WebSocketConstructorWithOptions);
    this.httpBridge = options.httpBridge ?? bridgeVelayHttpRequest;
    this.webSocketBridge = (
      options.webSocketBridgeFactory ?? defaultWebSocketBridgeFactory
    )(options.gatewayLoopbackBaseUrl, (frame) => this.sendFrame(frame));
    this.baseReconnectDelayMs =
      options.reconnect?.baseDelayMs ?? BASE_RECONNECT_DELAY_MS;
    this.maxReconnectDelayMs =
      options.reconnect?.maxDelayMs ?? MAX_RECONNECT_DELAY_MS;
    this.reconnectJitterRatio =
      options.reconnect?.jitterRatio ?? RECONNECT_JITTER_RATIO;
    this.random = options.reconnect?.random ?? Math.random;
    this.timerApi = options.timerApi ?? defaultTimerApi;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect().catch((err) => {
      this.connecting = false;
      log.error({ err }, "Failed to start Velay tunnel client");
      this.scheduleReconnect();
    });
  }

  stop(): void {
    this.running = false;
    this.connecting = false;
    if (this.reconnectTimer) {
      this.timerApi.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    this.webSocketBridge.closeAll();
    this.clearPublishedTwilioPublicBaseUrl();
    if (ws) {
      closeWebSocket(ws, 1000, "gateway shutdown");
    }
  }

  private async connect(): Promise<void> {
    if (!this.running || this.connecting) return;
    this.connecting = true;

    let apiKeyRaw: string | undefined;
    let platformAssistantIdRaw: string | undefined;
    try {
      [apiKeyRaw, platformAssistantIdRaw] = await Promise.all([
        this.options.credentials.get(
          credentialKey("vellum", "assistant_api_key"),
        ),
        this.options.credentials.get(
          credentialKey("vellum", "platform_assistant_id"),
        ),
      ]);
    } catch (err) {
      this.connecting = false;
      log.warn({ err }, "Failed to read Velay tunnel credentials");
      this.scheduleReconnect();
      return;
    }

    if (!this.running) {
      this.connecting = false;
      return;
    }

    const apiKey = apiKeyRaw?.trim();
    const platformAssistantId = platformAssistantIdRaw?.trim() || undefined;
    if (!apiKey) {
      this.connecting = false;
      log.info("Velay tunnel waiting for assistant API key");
      this.scheduleReconnect();
      return;
    }

    let registerUrl: string;
    try {
      registerUrl = buildRegisterWebSocketUrl(this.options.velayBaseUrl);
    } catch (err) {
      this.connecting = false;
      log.error({ err }, "Invalid Velay base URL");
      this.scheduleReconnect();
      return;
    }

    try {
      const ws = new this.webSocketConstructor(registerUrl, {
        protocols: [VELAY_TUNNEL_SUBPROTOCOL],
        headers: { Authorization: `Api-Key ${apiKey}` },
      });
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      this.connecting = false;

      ws.addEventListener("open", () => {
        if (this.ws !== ws || !this.running) return;
        this.reconnectAttempt = 0;
        log.info("Velay tunnel connected");
      });

      ws.addEventListener("message", (event) => {
        void this.handleMessage(event.data, ws, platformAssistantId).catch(
          (err) => {
            log.error({ err }, "Failed to handle Velay frame");
          },
        );
      });

      ws.addEventListener("close", (event) => {
        this.handleClose(ws, event);
      });

      ws.addEventListener("error", (event) => {
        if (this.ws !== ws || !this.running) return;
        log.warn({ error: String(event) }, "Velay tunnel WebSocket error");
        if (ws.readyState === WebSocket.CONNECTING) {
          this.disconnectActiveWebSocket(ws);
        }
      });
    } catch (err) {
      this.ws = null;
      this.connecting = false;
      log.warn({ err }, "Failed to connect Velay tunnel");
      this.scheduleReconnect();
    }
  }

  private async handleMessage(
    data: unknown,
    originWs: WebSocket,
    platformAssistantId: string | undefined,
  ): Promise<void> {
    if (this.ws !== originWs || !this.running) return;

    const frame = parseVelayFrame(data);
    if (!frame) {
      log.warn("Ignoring malformed Velay frame");
      return;
    }

    switch (frame.type) {
      case VELAY_FRAME_TYPES.registered:
        await this.handleRegisteredFrame(frame, originWs, platformAssistantId);
        return;
      case VELAY_FRAME_TYPES.httpRequest:
        await this.handleHttpRequestFrame(frame, originWs);
        return;
      case VELAY_FRAME_TYPES.websocketOpen:
      case VELAY_FRAME_TYPES.websocketMessage:
      case VELAY_FRAME_TYPES.websocketClose:
        this.webSocketBridge.handleFrame(frame);
        return;
      default:
        log.debug({ type: frame.type }, "Ignoring unsupported Velay frame");
    }
  }

  private async handleRegisteredFrame(
    frame: VelayRegisteredFrame,
    originWs: WebSocket,
    platformAssistantId: string | undefined,
  ): Promise<void> {
    if (platformAssistantId && frame.assistant_id !== platformAssistantId) {
      log.error(
        {
          expectedAssistantId: platformAssistantId,
          receivedAssistantId: frame.assistant_id,
        },
        "Velay registered assistant ID mismatch",
      );
      this.disconnectActiveWebSocket(originWs, 1008, "assistant ID mismatch");
      return;
    }

    await writeTwilioPublicBaseUrl(frame.public_url, this.options.configFile);
    this.publishedTwilioPublicBaseUrl = frame.public_url;
    log.info({ publicUrl: frame.public_url }, "Velay tunnel registered");
  }

  private async handleHttpRequestFrame(
    frame: VelayHttpRequestFrame,
    originWs: WebSocket,
  ): Promise<void> {
    const response = await this.httpBridge(
      frame,
      this.options.gatewayLoopbackBaseUrl,
    );
    if (this.ws !== originWs || !this.running) return;
    this.sendFrame(response);
  }

  private handleClose(ws: WebSocket, event: CloseEvent): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.connecting = false;
    this.webSocketBridge.closeAll();
    this.clearPublishedTwilioPublicBaseUrl();
    log.info(
      { code: event.code, reason: event.reason },
      "Velay tunnel disconnected",
    );
    this.scheduleReconnect();
  }

  private disconnectActiveWebSocket(
    ws: WebSocket,
    code?: number,
    reason?: string,
  ): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.connecting = false;
    this.webSocketBridge.closeAll();
    this.clearPublishedTwilioPublicBaseUrl();
    closeWebSocket(ws, code, reason);
    this.scheduleReconnect();
  }

  private clearPublishedTwilioPublicBaseUrl(): void {
    const publicUrl = this.publishedTwilioPublicBaseUrl;
    if (!publicUrl) return;
    this.publishedTwilioPublicBaseUrl = undefined;
    void clearTwilioPublicBaseUrl(publicUrl, this.options.configFile).catch(
      (err) => {
        log.error({ err }, "Failed to clear Velay Twilio public URL");
      },
    );
  }

  private sendFrame(frame: VelayFrame): void {
    const ws = this.ws;
    if (!this.running || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(frame));
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;

    const backoff = Math.min(
      this.baseReconnectDelayMs * Math.pow(2, this.reconnectAttempt),
      this.maxReconnectDelayMs,
    );
    const jitter = backoff * this.reconnectJitterRatio * this.random();
    const delay = Math.round(backoff + jitter);
    this.reconnectAttempt++;

    this.reconnectTimer = this.timerApi.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => {
        this.connecting = false;
        log.error({ err }, "Velay reconnect failed");
        this.scheduleReconnect();
      });
    }, delay);
  }
}

export function createVelayTunnelClient(
  config: GatewayConfig,
  deps: {
    credentials: CredentialCache;
    configFile: ConfigFileCache;
  },
): VelayTunnelClient | undefined {
  if (!config.velayBaseUrl) return undefined;
  return new VelayTunnelClient({
    velayBaseUrl: config.velayBaseUrl,
    gatewayLoopbackBaseUrl: config.gatewayInternalBaseUrl,
    credentials: deps.credentials,
    configFile: deps.configFile,
  });
}

const defaultTimerApi: TimerApi = {
  setTimeout: (fn, delayMs) => setTimeout(fn, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

function defaultWebSocketBridgeFactory(
  gatewayLoopbackBaseUrl: string,
  sendFrame: (frame: VelayFrame) => void,
): VelayWebSocketBridge {
  return new VelayWebSocketBridge(gatewayLoopbackBaseUrl, sendFrame);
}

async function writeTwilioPublicBaseUrl(
  publicUrl: string,
  configFile: ConfigFileCache,
): Promise<void> {
  return new Promise((resolve, reject) => {
    enqueueConfigWrite(() => {
      try {
        const result = readConfigFile();
        if (!result.ok) {
          log.error(
            { detail: result.detail },
            "Cannot publish Velay public URL because config.json is malformed",
          );
          resolve();
          return;
        }

        const data = result.data;
        const ingress =
          data.ingress &&
          typeof data.ingress === "object" &&
          !Array.isArray(data.ingress)
            ? { ...(data.ingress as Record<string, unknown>) }
            : {};
        if (ingress.twilioPublicBaseUrl === publicUrl) {
          resolve();
          return;
        }

        ingress.twilioPublicBaseUrl = publicUrl;
        data.ingress = ingress;
        writeConfigFileAtomic(data);
        configFile.invalidate();
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function clearTwilioPublicBaseUrl(
  publicUrl: string,
  configFile: ConfigFileCache,
): Promise<void> {
  return new Promise((resolve, reject) => {
    enqueueConfigWrite(() => {
      try {
        const result = readConfigFile();
        if (!result.ok) {
          log.error(
            { detail: result.detail },
            "Cannot clear Velay public URL because config.json is malformed",
          );
          resolve();
          return;
        }

        const data = result.data;
        if (
          !data.ingress ||
          typeof data.ingress !== "object" ||
          Array.isArray(data.ingress)
        ) {
          resolve();
          return;
        }

        const ingress = { ...(data.ingress as Record<string, unknown>) };
        if (ingress.twilioPublicBaseUrl !== publicUrl) {
          resolve();
          return;
        }

        delete ingress.twilioPublicBaseUrl;
        data.ingress = ingress;
        writeConfigFileAtomic(data);
        configFile.invalidate();
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
}

function buildRegisterWebSocketUrl(baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL("v1/register", normalizedBaseUrl);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("VELAY_BASE_URL must use http, https, ws, or wss");
  }
  return url.toString();
}

function parseVelayFrame(data: unknown): VelayFrame | undefined {
  const raw = decodeWebSocketData(data);
  if (raw === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const frame = parsed as Record<string, unknown>;

  switch (frame.type) {
    case VELAY_FRAME_TYPES.registered:
      return isRegisteredFrame(frame) ? frame : undefined;
    case VELAY_FRAME_TYPES.httpRequest:
      return isHttpRequestFrame(frame) ? frame : undefined;
    case VELAY_FRAME_TYPES.websocketOpen:
    case VELAY_FRAME_TYPES.websocketMessage:
    case VELAY_FRAME_TYPES.websocketClose:
      return isWebSocketInboundFrame(frame) ? frame : undefined;
    default:
      return undefined;
  }
}

function decodeWebSocketData(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf8",
    );
  }
  return undefined;
}

function isRegisteredFrame(
  frame: Record<string, unknown>,
): frame is VelayRegisteredFrame {
  return (
    frame.type === VELAY_FRAME_TYPES.registered &&
    typeof frame.assistant_id === "string" &&
    typeof frame.public_url === "string"
  );
}

function isHttpRequestFrame(
  frame: Record<string, unknown>,
): frame is VelayHttpRequestFrame {
  return (
    frame.type === VELAY_FRAME_TYPES.httpRequest &&
    typeof frame.request_id === "string" &&
    typeof frame.method === "string" &&
    typeof frame.path === "string" &&
    isOptionalString(frame.raw_query) &&
    isOptionalString(frame.body_base64) &&
    isVelayHeaders(frame.headers)
  );
}

function isWebSocketInboundFrame(
  frame: Record<string, unknown>,
): frame is VelayWebSocketInboundFrame {
  if (frame.type === VELAY_FRAME_TYPES.websocketOpen) {
    return (
      typeof frame.connection_id === "string" &&
      typeof frame.path === "string" &&
      isOptionalString(frame.raw_query) &&
      isOptionalString(frame.subprotocol) &&
      isVelayHeaders(frame.headers)
    );
  }
  if (frame.type === VELAY_FRAME_TYPES.websocketMessage) {
    return (
      typeof frame.connection_id === "string" &&
      typeof frame.message_type === "string" &&
      isOptionalString(frame.body_base64)
    );
  }
  if (frame.type === VELAY_FRAME_TYPES.websocketClose) {
    return (
      typeof frame.connection_id === "string" &&
      (frame.code === undefined || typeof frame.code === "number") &&
      isOptionalString(frame.reason)
    );
  }
  return false;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isVelayHeaders(value: unknown): value is Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(
    (headerValues) =>
      Array.isArray(headerValues) &&
      headerValues.every((headerValue) => typeof headerValue === "string"),
  );
}

function closeWebSocket(ws: WebSocket, code?: number, reason?: string): void {
  if (
    ws.readyState === WebSocket.CONNECTING ||
    ws.readyState === WebSocket.OPEN
  ) {
    ws.close(code, reason);
  }
}
