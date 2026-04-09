import { v4 as uuid } from "uuid";

import type {
  BrowserBackend,
  BrowserSession,
  CdpCommand,
  CdpResult,
} from "./types.js";

export interface BrowserSessionManagerOptions {
  /** Ordered list of backends to try; first available wins. */
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
   *   boundary against stale ids. If the session has an opaque `targetId` and the command does
   *   not already carry its own CDP `sessionId`, the manager injects the session's `targetId`
   *   as the CDP `sessionId` so backends can multiplex commands across multiple tabs/targets.
   * - If `sessionId` is `undefined`, the first available backend is selected for one-off
   *   commands without a session handle (e.g. transport health probes).
   */
  async send(
    sessionId: string | undefined,
    command: CdpCommand,
    signal?: AbortSignal,
  ): Promise<CdpResult> {
    let backend: BrowserBackend;
    let outgoing = command;
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
      // If the session has an opaque targetId and the command does not
      // carry its own CDP sessionId, inject the session's targetId as
      // the CDP sessionId. Backends that support multi-target routing
      // will forward it; backends that ignore it will treat the call
      // as "most-recent-tab" as before.
      if (session.targetId !== undefined && command.sessionId === undefined) {
        outgoing = { ...command, sessionId: session.targetId };
      }
    } else {
      backend = this.selectBackend();
    }
    return backend.send(outgoing, signal);
  }

  disposeSession(id: string): void {
    this.sessions.delete(id);
  }

  disposeAll(): void {
    for (const b of this.backends) b.dispose();
    this.sessions.clear();
  }
}
