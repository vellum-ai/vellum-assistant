export type BrowserBackendKind = "extension" | "local" | "cdp-inspect";

export interface CdpCommand {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface CdpResult {
  /** Raw CDP result object; opaque to the manager. */
  result?: unknown;
  /** CDP error envelope if the command failed. */
  error?: { code: number; message: string; data?: unknown };
}

export interface BrowserSession {
  id: string;
  backendKind: BrowserBackendKind;
  /** Opaque target/sessionId from the backend. Omitted for "most-recent-tab" commands. */
  targetId?: string;
}

export interface BrowserBackend {
  kind: BrowserBackendKind;
  isAvailable(): boolean;
  send(command: CdpCommand, signal?: AbortSignal): Promise<CdpResult>;
  dispose(): void;
}
