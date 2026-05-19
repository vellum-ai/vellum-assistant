import { invoke } from "@tauri-apps/api/core";

import type { AssistantConnection } from "../types.js";
import { GatewayClient } from "./gateway-client.js";
import { isTauriRuntime } from "./tauri-runtime.js";

interface ActiveWindowContext {
  readonly appId: string;
  readonly appName: string;
  readonly windowTitle: string;
  readonly redacted: boolean;
}

interface PerceptionEvent {
  readonly eventId: string;
  readonly ts: string;
  readonly source: {
    readonly module: string;
    readonly version?: string;
  };
  readonly payload: {
    readonly kind: "app_focus_changed";
    readonly appId: string;
    readonly appName: string;
    readonly windowTitle: string;
    readonly redacted: boolean;
  };
}

interface PublishPerceptionResponse {
  readonly accepted: boolean;
  readonly reason?: "disabled";
}

const SAMPLE_INTERVAL_MS = 5_000;

export class PerceptionClient {
  private readonly gatewayClient: GatewayClient;
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastSignature: string | null = null;
  private inFlight = false;

  constructor(connection: AssistantConnection) {
    this.gatewayClient = new GatewayClient(connection);
  }

  start(): void {
    if (!isTauriRuntime() || this.interval) return;
    void this.sampleAndPublish();
    this.interval = setInterval(
      () => void this.sampleAndPublish(),
      SAMPLE_INTERVAL_MS,
    );
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  private async sampleAndPublish(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const context = await invoke<ActiveWindowContext | null>(
        "active_window_context",
      );
      if (!context) return;

      const signature = [
        context.appId,
        context.appName,
        context.windowTitle,
        String(context.redacted),
      ].join("\u0000");
      if (signature === this.lastSignature) return;

      const response =
        await this.gatewayClient.postJsonResult<PublishPerceptionResponse>(
          "perception/publish",
          {
            eventId: cryptoId(),
            ts: new Date().toISOString(),
            source: { module: "clients/tauri" },
            payload: {
              kind: "app_focus_changed",
              appId: context.appId,
              appName: context.appName,
              windowTitle: context.windowTitle,
              redacted: context.redacted,
            },
          } satisfies PerceptionEvent,
        );
      if (response.accepted) {
        this.lastSignature = signature;
      }
    } catch {
      // Perception is best-effort and feature-flagged; failures must not
      // interfere with voice, host proxy, or the HUD itself.
    } finally {
      this.inFlight = false;
    }
  }
}

function cryptoId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}
