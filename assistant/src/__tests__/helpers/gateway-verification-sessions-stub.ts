/**
 * Configurable stub factory for `channels/gateway-verification-sessions.js`.
 *
 * For unit tests that mock the gateway-backed session client module directly:
 *
 *   const stub = createGatewayVerificationSessionsStub({
 *     mintResult: () => ({ sessionId: "sess-1", ... }),
 *   });
 *   mock.module("../../../channels/gateway-verification-sessions.js", () => stub.module);
 *   beforeEach(() => stub.reset());
 *
 * Handles: per-method (or global) "gateway unreachable" throw toggles,
 * call recorders, conflict injection for the conditional create, and
 * settable session/mint results. Session reads (`findActiveSession` /
 * `getPendingSession`) record before the unreachable check — the read
 * IPC attempt itself is what some tests count; all other methods throw
 * before recording, so an unreachable call never counts as made.
 *
 * Stateful integration suites should use `verification-sessions-ipc-sim.ts`
 * instead — this factory complements the sim, it does not replace it.
 *
 * Self-contained by design (assistant/AGENTS.md — test machinery isolation):
 * no production `src/` imports.
 */

export interface GatewaySessionMintResult {
  sessionId: string;
  secret: string;
  challengeHash: string;
  expiresAt: number;
  ttlSeconds: number;
}

type StubMethod =
  | "resolveBootstrapToken"
  | "bindSessionIdentity"
  | "updateSessionStatus"
  | "createOutboundSession"
  | "createOutboundSessionConditional"
  | "updateSessionDelivery"
  | "findActiveSession"
  | "getPendingSession";

type SessionRecord = Record<string, unknown> | null;

export interface GatewayVerificationSessionsStub {
  /** Module-shaped object: `mock.module(path, () => stub.module)`. */
  module: Record<StubMethod, (...args: unknown[]) => Promise<unknown>>;
  /** Throw toggles: `unreachable.all` or a single method by name. */
  unreachable: { all: boolean } & Record<StubMethod, boolean>;
  calls: {
    resolveBootstrapToken: unknown[][];
    bindSessionIdentity: unknown[][];
    updateSessionStatus: unknown[][];
    /** Params from both mint variants (plain + conditional). */
    create: unknown[];
    updateSessionDelivery: unknown[][];
    /** Method names of verification-read IPC calls, in order. */
    sessionReads: string[];
  };
  state: {
    bootstrapSession: SessionRecord;
    activeSession: SessionRecord;
    pendingSession: SessionRecord;
    mintResult: GatewaySessionMintResult;
    /** When set, the conditional create returns `{ conflict: true, reason }`. */
    conflictReason: string | null;
  };
  /** Clears recorders/toggles/sessions and re-mints the default result. */
  reset(): void;
}

export function createGatewayVerificationSessionsStub(options: {
  mintResult: () => GatewaySessionMintResult;
}): GatewayVerificationSessionsStub {
  const unreachable = {
    all: false,
    resolveBootstrapToken: false,
    bindSessionIdentity: false,
    updateSessionStatus: false,
    createOutboundSession: false,
    createOutboundSessionConditional: false,
    updateSessionDelivery: false,
    findActiveSession: false,
    getPendingSession: false,
  };

  const calls: GatewayVerificationSessionsStub["calls"] = {
    resolveBootstrapToken: [],
    bindSessionIdentity: [],
    updateSessionStatus: [],
    create: [],
    updateSessionDelivery: [],
    sessionReads: [],
  };

  const state: GatewayVerificationSessionsStub["state"] = {
    bootstrapSession: null,
    activeSession: null,
    pendingSession: null,
    mintResult: options.mintResult(),
    conflictReason: null,
  };

  function throwIfUnreachable(method: StubMethod): void {
    if (unreachable.all || unreachable[method]) {
      throw new Error("gateway unreachable");
    }
  }

  const module: GatewayVerificationSessionsStub["module"] = {
    resolveBootstrapToken: async (...args: unknown[]) => {
      throwIfUnreachable("resolveBootstrapToken");
      calls.resolveBootstrapToken.push(args);
      return state.bootstrapSession;
    },
    bindSessionIdentity: async (...args: unknown[]) => {
      throwIfUnreachable("bindSessionIdentity");
      calls.bindSessionIdentity.push(args);
    },
    updateSessionStatus: async (...args: unknown[]) => {
      throwIfUnreachable("updateSessionStatus");
      calls.updateSessionStatus.push(args);
    },
    createOutboundSession: async (params: unknown) => {
      throwIfUnreachable("createOutboundSession");
      calls.create.push(params);
      return state.mintResult;
    },
    createOutboundSessionConditional: async (params: unknown) => {
      throwIfUnreachable("createOutboundSessionConditional");
      calls.create.push(params);
      if (state.conflictReason !== null) {
        return { conflict: true, reason: state.conflictReason };
      }
      return state.mintResult;
    },
    updateSessionDelivery: async (...args: unknown[]) => {
      throwIfUnreachable("updateSessionDelivery");
      calls.updateSessionDelivery.push(args);
    },
    findActiveSession: async () => {
      calls.sessionReads.push("findActiveSession");
      throwIfUnreachable("findActiveSession");
      return state.activeSession;
    },
    getPendingSession: async () => {
      calls.sessionReads.push("getPendingSession");
      throwIfUnreachable("getPendingSession");
      return state.pendingSession;
    },
  };

  function reset(): void {
    for (const key of Object.keys(unreachable) as Array<
      keyof typeof unreachable
    >) {
      unreachable[key] = false;
    }
    for (const recorder of Object.values(calls)) {
      recorder.length = 0;
    }
    state.bootstrapSession = null;
    state.activeSession = null;
    state.pendingSession = null;
    state.mintResult = options.mintResult();
    state.conflictReason = null;
  }

  return { module, unreachable, calls, state, reset };
}
