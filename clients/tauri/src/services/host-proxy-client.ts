import { invoke } from "@tauri-apps/api/core";

import type { AssistantConnection, HostProxyStatus } from "../types.js";
import { captureCameraSnapshot } from "./camera-snapshot.js";
import { GatewayClient } from "./gateway-client.js";
import { GatewayEventStream, type GatewayServerMessage } from "./gateway-events.js";
import { isTauriRuntime } from "./tauri-runtime.js";

export type HostProxyStatusListener = (status: HostProxyStatus) => void;

interface HostResult {
  readonly endpoint: string;
  readonly payload: unknown;
}

interface HostProxyClientOptions {
  readonly onStatus?: HostProxyStatusListener;
}

interface ActionLifecycleMessage extends GatewayServerMessage {
  readonly type: "action_lifecycle";
  readonly actionName?: string;
  readonly stage?: string;
  readonly message?: string;
}

const HOST_INSTANCE_STORAGE_KEY = "eli-hud-host-instance";

export function getOrCreateHostClientId(): string {
  const existing = globalThis.localStorage?.getItem(HOST_INSTANCE_STORAGE_KEY);
  if (existing) return existing;
  const id = `tauri-${cryptoId()}`;
  globalThis.localStorage?.setItem(HOST_INSTANCE_STORAGE_KEY, id);
  return id;
}

export class HostProxyClient {
  private readonly connection: AssistantConnection;
  private readonly clientId: string;
  private readonly gatewayClient: GatewayClient;
  private readonly onStatus?: HostProxyStatusListener;
  private stream: GatewayEventStream | null = null;

  constructor(connection: AssistantConnection, options: HostProxyClientOptions = {}) {
    this.connection = connection;
    this.clientId = getOrCreateHostClientId();
    this.gatewayClient = new GatewayClient(connection);
    this.onStatus = options.onStatus;
    this.emitStatus({ lastAction: "Host proxy ready.", lastError: null });
  }

  start(): void {
    if (this.stream) return;
    const stream = new GatewayEventStream(
      this.connection,
      {
        onEvent: (event) => void this.handleEvent(event),
        onOpen: () =>
          this.emitStatus({ lastAction: "Host proxy linked.", lastError: null }),
        onError: (err) =>
          this.emitStatus({
            lastAction: null,
            lastError: `Host proxy stream error: ${errorMessage(err)}`,
          }),
      },
      { clientId: this.clientId },
    );
    stream.start();
    this.stream = stream;
  }

  stop(): void {
    this.stream?.stop();
    this.stream = null;
  }

  private async handleEvent(event: GatewayServerMessage): Promise<void> {
    const message = (event.message ?? event) as GatewayServerMessage;
    if (!message || typeof message.type !== "string") return;

    try {
      switch (message.type) {
        case "action_lifecycle":
          this.handleActionLifecycle(message as ActionLifecycleMessage);
          break;
        case "host_bash_request":
          await this.execute("host_execute_bash", message, "host-bash-result");
          break;
        case "host_file_request":
          await this.execute("host_execute_file", message, "host-file-result");
          break;
        case "host_browser_request":
          await this.execute("host_execute_browser", message, "host-browser-result");
          break;
        case "host_app_control_request":
          await this.execute(
            "host_execute_app_control",
            message,
            "host-app-control-result",
          );
          break;
        case "host_camera_request":
          await this.executeCameraSnapshot(message);
          break;
        case "host_bash_cancel":
          await invoke("host_cancel_bash", { requestId: message.requestId });
          break;
        default:
          break;
      }
    } catch (err) {
      this.emitStatus({
        lastAction: null,
        lastError: `Host proxy failed: ${errorMessage(err)}`,
      });
    }
  }

  private async executeCameraSnapshot(message: GatewayServerMessage): Promise<void> {
    const requestId =
      typeof message.requestId === "string" ? message.requestId : null;
    if (!requestId) return;

    this.emitStatus({
      lastAction: "Requesting one webcam snapshot.",
      lastError: null,
    });

    try {
      const snapshot = await captureCameraSnapshot();
      await this.gatewayClient.postJson(
        "host-camera-result",
        {
          requestId,
          ...snapshot,
        },
        { clientId: this.clientId },
      );
      this.emitStatus({
        lastAction: "Completed webcam snapshot.",
        lastError: null,
      });
    } catch (err) {
      const messageText = errorMessage(err);
      await this.gatewayClient.postJson(
        "host-camera-result",
        {
          requestId,
          error: messageText,
        },
        { clientId: this.clientId },
      );
      this.emitStatus({
        lastAction: null,
        lastError: `Camera snapshot failed: ${messageText}`,
      });
    }
  }

  private async execute(
    command: string,
    message: GatewayServerMessage,
    fallbackEndpoint: string,
  ): Promise<void> {
    if (!isTauriRuntime()) {
      this.emitStatus({
        lastAction: null,
        lastError: "Host actions require the Tauri app, not browser preview.",
      });
      return;
    }

    this.emitStatus({
      lastAction: `Running ${message.type.replace(/_/g, " ")}.`,
      lastError: null,
    });
    const result = await invoke<HostResult | unknown>(command, { request: message });
    const endpoint =
      typeof result === "object" &&
      result !== null &&
      "endpoint" in result &&
      typeof (result as HostResult).endpoint === "string"
        ? (result as HostResult).endpoint
        : fallbackEndpoint;
    const payload =
      typeof result === "object" && result !== null && "payload" in result
        ? (result as HostResult).payload
        : result;

    await this.gatewayClient.postJson(endpoint, payload, {
      clientId: this.clientId,
    });
    this.emitStatus({
      lastAction: `Completed ${message.type.replace(/_/g, " ")}.`,
      lastError: null,
    });
  }

  private emitStatus(
    patch: Omit<HostProxyStatus, "clientId">,
  ): void {
    this.onStatus?.({
      clientId: this.clientId,
      ...patch,
    });
  }

  private handleActionLifecycle(message: ActionLifecycleMessage): void {
    const actionName = message.actionName ?? "action";
    const stage = message.stage ?? "executing";
    const stageLabel = stage.replaceAll("_", " ");
    if (stage === "failed") {
      this.emitStatus({
        lastAction: null,
        lastError:
          message.message ?? `Action failed: ${actionName} (${stageLabel})`,
      });
      return;
    }
    this.emitStatus({
      lastAction:
        message.message ?? `${actionName.replaceAll("_", " ")} ${stageLabel}.`,
      lastError: null,
    });
  }
}

function cryptoId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}
