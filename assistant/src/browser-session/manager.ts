import { v4 as uuid } from "uuid";

import type {
  BrowserBackend,
  BrowserSession,
  CdpCommand,
  CdpResult,
} from "./types.js";

export interface BrowserSessionManagerOptions {
  /** Ordered list of backends to try; first available wins. Phase 2 only has extension. */
  backends: BrowserBackend[];
}

export class BrowserSessionManager {
  private backends: BrowserBackend[];
  private sessions = new Map<string, BrowserSession>();

  constructor(opts: BrowserSessionManagerOptions) {
    this.backends = opts.backends;
  }

  /** Pick an available backend or throw. */
  selectBackend(): BrowserBackend {
    const b = this.backends.find((x) => x.isAvailable());
    if (!b) throw new Error("No available browser backend");
    return b;
  }

  createSession(): BrowserSession {
    const backend = this.selectBackend();
    const session: BrowserSession = { id: uuid(), backendKind: backend.kind };
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(id: string): BrowserSession | undefined {
    return this.sessions.get(id);
  }

  /**
   * Dispatch a CDP command.
   *
   * - If `sessionId` is provided, the session must exist in the manager; otherwise this throws.
   *   The command is routed through the backend whose `kind` matches the session's `backendKind`,
   *   ensuring per-session backend isolation and making `disposeSession()` an actual enforcement
   *   boundary against stale ids.
   * - If `sessionId` is `undefined`, the first available backend is selected (legacy advisory
   *   behavior used for one-off commands without a session handle).
   *
   * Phase 2 only has the extension backend so routing is effectively a no-op, but Phase 4 will
   * rely on this contract once multi-backend / multi-tab multiplexing lands.
   */
  async send(
    sessionId: string | undefined,
    command: CdpCommand,
    signal?: AbortSignal,
  ): Promise<CdpResult> {
    let backend: BrowserBackend;
    if (sessionId !== undefined) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        throw new Error(`Unknown browser session: ${sessionId}`);
      }
      const matched = this.backends.find((b) => b.kind === session.backendKind);
      if (!matched) {
        throw new Error(
          `No backend available for session kind: ${session.backendKind}`,
        );
      }
      backend = matched;
    } else {
      backend = this.selectBackend();
    }
    return backend.send(command, signal);
  }

  disposeSession(id: string): void {
    this.sessions.delete(id);
  }

  disposeAll(): void {
    for (const b of this.backends) b.dispose();
    this.sessions.clear();
  }
}
