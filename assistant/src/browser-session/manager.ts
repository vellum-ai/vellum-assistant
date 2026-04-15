import { v4 as uuid } from "uuid";

import { consumeInvalidatedTargetId } from "./events.js";
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
      // If the chrome extension has reported this session's target
      // as detached since the last dispatch, evict the session and
      // throw so the caller can create a fresh one. Reading (and
      // consuming) the invalidation flag here keeps the "next
      // command forces reattach" semantics in lockstep with the
      // host_browser_session_invalidated envelope handler — without
      // this check the manager would happily forward a CDP command
      // against a torn-down target and hit a permanent failure.
      if (
        session.targetId !== undefined &&
        consumeInvalidatedTargetId(session.targetId)
      ) {
        this.sessions.delete(sessionId);
        throw new Error(
          `Browser session ${sessionId} was invalidated (target ${session.targetId} detached)`,
        );
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

  /**
   * Evict a session that the backend has informed us is no longer
   * valid — e.g. the chrome extension dispatched a
   * `host_browser_session_invalidated` envelope after Chrome detached
   * the debugger from the underlying tab/target.
   *
   * Functionally equivalent to {@link disposeSession} today (both
   * remove the session from the manager's map so a subsequent
   * `send()` throws "Unknown browser session") but preserved as a
   * distinct method so call sites can stay explicit about intent.
   * Callers that receive a detach/invalidated signal should use this
   * method; callers that are cleaning up at end-of-lifecycle should
   * use {@link disposeSession}.
   *
   * Returns `true` when a session was actually removed, `false` when
   * no session with that id was tracked. Returning a boolean lets
   * transport-level dispatchers (see
   * `resolveHostBrowserSessionInvalidated`) log at the right level
   * based on whether the invalidation had any effect.
   */
  invalidateSession(id: string): boolean {
    return this.sessions.delete(id);
  }

  /**
   * Evict every session whose opaque `targetId` matches the supplied
   * id. Used by the WS dispatcher when a `host_browser_session_invalidated`
   * envelope arrives without a manager-level session id: the
   * extension-side dispatcher only knows its own `tabId` / `targetId`
   * and does not carry our uuid session handle.
   *
   * Returns the number of sessions removed. A zero return does not
   * necessarily indicate an error — the target may not have a
   * runtime-side session attached to it yet, or the session may
   * already have been disposed by its owning tool.
   */
  invalidateByTargetId(targetId: string): number {
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (session.targetId === targetId) {
        this.sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  disposeAll(): void {
    for (const b of this.backends) b.dispose();
    this.sessions.clear();
  }
}
