/**
 * Shared types for the Eli HUD client. Keep this file framework-free
 * so it can be imported by both React components and plain services.
 */

export type AssistantMode =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "offline";

export interface TranscriptEntry {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  /** Wall-clock timestamp in ms. */
  readonly timestamp: number;
  /**
   * `partial` entries can still be amended; `final` entries are
   * immutable. Used to drive cursor-blink styling on streaming output.
   */
  readonly state: "partial" | "final";
}

export interface AssistantConnection {
  /** Daemon HTTP base URL, e.g. `http://localhost:7821`. */
  readonly httpBaseUrl: string;
  /** WebSocket base URL, e.g. `ws://localhost:7821`. */
  readonly wsBaseUrl: string;
  /** Bearer token if the daemon requires auth, otherwise `null`. */
  readonly bearerToken: string | null;
  /** Unique identifier for the active assistant ("self" for local). */
  readonly assistantId: string;
}

export interface VoiceConfigSnapshot {
  readonly alwaysOn: boolean;
  readonly wakeWord: {
    readonly enabled: boolean;
    readonly keywords: readonly { readonly label: string }[];
    readonly runOnClient: boolean;
  };
  readonly vad: {
    readonly silenceMs: number;
    readonly minUtteranceMs: number;
    readonly maxUtteranceMs: number;
  };
}

export interface ConnectionStatus {
  readonly connected: boolean;
  readonly model: string | null;
  readonly latencyMs: number | null;
  readonly lastError: string | null;
}
