import type { OutgoingHttpHeaders } from "node:http";

import { normalizeHttpPublicBaseUrl } from "@vellumai/service-contracts/ingress";

import type { GatewayConfig } from "../config.js";
import type { ConfigFileCache } from "../config-file-cache.js";
import type { CredentialCache } from "../credential-cache.js";
import { credentialKey } from "../credential-key.js";
import { mutateConfigFile } from "../config-file-utils.js";
import { getLogger } from "../logger.js";
import { bridgeVelayHttpRequest } from "./http-bridge.js";
import { closeWebSocket } from "./bridge-utils.js";
import {
  VELAY_FRAME_TYPES,
  VELAY_TUNNEL_SUBPROTOCOL,
  parseVelayFrame,
  type VelayFrame,
  type VelayHttpRequestFrame,
  type VelayRegisteredFrame,
} from "./protocol.js";
import { VelayWebSocketBridge } from "./websocket-bridge.js";

const log = getLogger("velay-client");

const BASE_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 30_000;
const RECONNECT_JITTER_RATIO = 0.5;
const VELAY_POLICY_CLOSE_CODE = 4008;

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
  private unsubscribeConfigInvalidation: (() => void) | undefined;

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
    this.unsubscribeConfigInvalidation ??= this.options.configFile.onInvalidate(
      () => {
        this.handleConfigInvalidated();
      },
    );
    this.startAsync().catch((err) => {
      this.connecting = false;
      log.error({ err }, "Failed to start Velay tunnel client");
      this.scheduleReconnect();
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.connecting = false;
    this.unsubscribeConfigInvalidation?.();
    this.unsubscribeConfigInvalidation = undefined;
    if (this.reconnectTimer) {
      this.timerApi.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    this.webSocketBridge.closeAll();
    await this.clearPublishedTwilioPublicBaseUrl();
    if (ws) {
      closeWebSocket(ws, 1000, "gateway shutdown");
    }
  }

  private async startAsync(): Promise<void> {
    await clearManagedPublicBaseUrl(this.options.configFile);
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (!this.running || this.connecting) return;
    this.connecting = true;

    if (this.isPublicIngressDisabled()) {
      this.connecting = false;
      await this.clearPublishedTwilioPublicBaseUrl();
      log.info("Velay tunnel waiting because public ingress is disabled");
      this.scheduleReconnect();
      return;
    }

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
    const expectedAssistantId = platformAssistantId;

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
        log.info("Velay tunnel connected");
      });

      ws.addEventListener("message", (event) => {
        void this.handleMessage(event.data, ws, expectedAssistantId).catch(
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
      this.disconnectActiveWebSocket(
        originWs,
        VELAY_POLICY_CLOSE_CODE,
        "assistant ID mismatch",
      );
      return;
    }

    const publicUrl = normalizeHttpPublicBaseUrl(frame.public_url);
    if (!publicUrl) {
      log.error(
        { publicUrl: frame.public_url },
        "Velay registered invalid Twilio public URL",
      );
      this.disconnectActiveWebSocket(
        originWs,
        VELAY_POLICY_CLOSE_CODE,
        "invalid public URL",
      );
      return;
    }

    if (this.isPublicIngressDisabled()) {
      log.info(
        { publicUrl },
        "Skipping Velay Twilio public URL publish because public ingress is disabled",
      );
      this.disconnectActiveWebSocket(originWs, 1000, "public ingress disabled");
      return;
    }

    await writeManagedPublicBaseUrl(publicUrl, this.options.configFile);
    this.publishedTwilioPublicBaseUrl = publicUrl;
    this.reconnectAttempt = 0;
    log.info({ publicUrl }, "Velay tunnel registered");
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
    log.info(
      { code: event.code, reason: event.reason },
      "Velay tunnel disconnected",
    );
    this.clearPublishedTwilioPublicBaseUrlThenReconnect();
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
    closeWebSocket(ws, code, reason);
    this.clearPublishedTwilioPublicBaseUrlThenReconnect();
  }

  private async clearPublishedTwilioPublicBaseUrl(): Promise<void> {
    const publicUrl = this.publishedTwilioPublicBaseUrl;
    if (!publicUrl) return;
    this.publishedTwilioPublicBaseUrl = undefined;
    try {
      await clearManagedPublicBaseUrl(this.options.configFile, publicUrl);
    } catch (err) {
      log.error({ err }, "Failed to clear Velay Twilio public URL");
    }
  }

  private clearPublishedTwilioPublicBaseUrlThenReconnect(): void {
    void this.clearPublishedTwilioPublicBaseUrl()
      .catch((err) => {
        log.error({ err }, "Failed to clear Velay Twilio public URL");
      })
      .finally(() => {
        this.scheduleReconnect();
      });
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

  private handleConfigInvalidated(): void {
    const ws = this.ws;
    if (!ws || !this.isPublicIngressDisabled()) return;

    log.info("Closing Velay tunnel because public ingress is disabled");
    this.disconnectActiveWebSocket(ws, 1000, "public ingress disabled");
  }

  private isPublicIngressDisabled(): boolean {
    return (
      this.options.configFile.getBoolean("ingress", "enabled", {
        force: true,
      }) === false
    );
  }
}

export function createVelayTunnelClient(
  config: GatewayConfig,
  deps: {
    credentials: CredentialCache;
    configFile: ConfigFileCache;
  },
): VelayTunnelClient | undefined {
  if (!config.velayBaseUrl) {
    const isPlatform =
      process.env.IS_PLATFORM?.trim().toLowerCase() === "true" ||
      process.env.IS_PLATFORM?.trim() === "1";
    if (isPlatform) {
      log.warn(
        "VELAY_BASE_URL is not configured on a platform pod — the assistant tunnel will not be established and inbound webhook delivery will fail",
      );
    }
    void clearManagedPublicBaseUrl(deps.configFile).catch((err) => {
      log.error({ err }, "Failed to clear disabled Velay Twilio public URL");
    });
    return undefined;
  }
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

async function mutateGatewayConfigFile(
  configFile: ConfigFileCache,
  malformedLogMessage: string,
  mutate: (data: Record<string, unknown>) => boolean,
): Promise<void> {
  const result = await mutateConfigFile(mutate, {
    shouldWrite: (changed) => changed,
    onWritten: () => {
      configFile.invalidate();
    },
  });
  if (!result.ok) {
    log.error({ detail: result.detail }, malformedLogMessage);
  }
}

const VELAY_MANAGED_BY = "velay";

async function writeManagedPublicBaseUrl(
  publicUrl: string,
  configFile: ConfigFileCache,
): Promise<void> {
  return mutateGatewayConfigFile(
    configFile,
    "Cannot publish Velay public URL because config.json is malformed",
    (data) => {
      const ingress = getMutableIngress(data);
      if (
        ingress.publicBaseUrl === publicUrl &&
        ingress.publicBaseUrlManagedBy === VELAY_MANAGED_BY
      ) {
        return false;
      }

      ingress.publicBaseUrl = publicUrl;
      ingress.publicBaseUrlManagedBy = VELAY_MANAGED_BY;
      data.ingress = ingress;
      return true;
    },
  );
}

async function clearManagedPublicBaseUrl(
  configFile: ConfigFileCache,
  expectedPublicUrl?: string,
): Promise<void> {
  return mutateGatewayConfigFile(
    configFile,
    "Cannot clear Velay public URL because config.json is malformed",
    (data) => {
      if (
        !data.ingress ||
        typeof data.ingress !== "object" ||
        Array.isArray(data.ingress)
      ) {
        return false;
      }

      const ingress = { ...(data.ingress as Record<string, unknown>) };
      if (ingress.publicBaseUrlManagedBy !== VELAY_MANAGED_BY) {
        return false;
      }
      if (
        expectedPublicUrl !== undefined &&
        ingress.publicBaseUrl !== expectedPublicUrl
      ) {
        delete ingress.publicBaseUrlManagedBy;
        data.ingress = ingress;
        return true;
      }

      delete ingress.publicBaseUrl;
      delete ingress.publicBaseUrlManagedBy;
      data.ingress = ingress;
      return true;
    },
  );
}

function getMutableIngress(
  data: Record<string, unknown>,
): Record<string, unknown> {
  return data.ingress &&
    typeof data.ingress === "object" &&
    !Array.isArray(data.ingress)
    ? { ...(data.ingress as Record<string, unknown>) }
    : {};
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
