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

  async send(
    sessionId: string | undefined,
    command: CdpCommand,
    signal?: AbortSignal,
  ): Promise<CdpResult> {
    // For now, session is advisory — all extension-backend commands route through the same connection.
    // Phase 4 will use sessionId to route to specific targets when multi-tab multiplexing lands.
    const backend = this.selectBackend();
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
