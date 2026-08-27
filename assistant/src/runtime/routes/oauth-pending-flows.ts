/**
 * In-memory registry of in-flight OAuth flows, keyed by a state token.
 *
 * Browser-mediated OAuth finishes out of band: the daemon starts a flow, hands
 * the client a state token, and completes the flow in the background (loopback
 * capture, device-code poll) or on a later request (a pasted code). The client
 * polls a status route with the state token to learn the outcome.
 *
 * Each caller creates its own registry so flows from different providers never
 * share a key space. Entries expire after a TTL so the map cannot grow
 * unbounded; call `cleanupExpired()` when starting a flow.
 */

const DEFAULT_PENDING_FLOW_TTL_MS = 10 * 60 * 1000; // 10 minutes

export type PendingFlowStatus = "pending" | "connected" | "error";

/** Fields every tracked flow carries, whatever the provider or transport. */
export interface PendingFlowFields {
  status: PendingFlowStatus;
  /** Human-readable failure detail, set when `status` is `error`. */
  error?: string;
  /** Machine-readable failure code, when the provider supplies one. */
  errorCode?: string;
  createdAt: number;
}

/** A tracked flow: the common fields plus whatever the caller stashed on it. */
export type PendingFlow<TExtra extends object> = PendingFlowFields & TExtra;

/** The subset of a flow that status routes report back to clients. */
export interface PendingFlowStatusReport {
  status: PendingFlowStatus;
  error?: string;
  errorCode?: string;
}

export interface PendingFlowMarkOptions {
  error?: string;
  errorCode?: string;
}

export interface PendingFlowRegistry<TExtra extends object> {
  /** How long an entry lives before `cleanupExpired()` drops it. */
  readonly ttlMs: number;
  /** Track a new pending flow under `state` and return the stored entry. */
  start(state: string, extra: TExtra): PendingFlow<TExtra>;
  get(state: string): PendingFlow<TExtra> | undefined;
  delete(state: string): void;
  /** Update a tracked flow's status in place, if it still exists. */
  mark(
    state: string,
    status: PendingFlowStatus,
    options?: PendingFlowMarkOptions,
  ): void;
  isExpired(flow: PendingFlowFields, now?: number): boolean;
  /** Status view of a tracked flow, or `undefined` when there is no such flow. */
  readStatus(state: string): PendingFlowStatusReport | undefined;
  /** Drop entries older than the TTL. */
  cleanupExpired(): void;
}

export interface PendingFlowRegistryOptions {
  ttlMs?: number;
}

export function createPendingFlowRegistry<
  TExtra extends object = Record<string, never>,
>(options: PendingFlowRegistryOptions = {}): PendingFlowRegistry<TExtra> {
  const ttlMs = options.ttlMs ?? DEFAULT_PENDING_FLOW_TTL_MS;
  const flows = new Map<string, PendingFlow<TExtra>>();

  return {
    ttlMs,

    start(state, extra) {
      const flow = {
        ...extra,
        status: "pending",
        createdAt: Date.now(),
      } as PendingFlow<TExtra>;
      flows.set(state, flow);
      return flow;
    },

    get(state) {
      return flows.get(state);
    },

    delete(state) {
      flows.delete(state);
    },

    mark(state, status, markOptions) {
      const flow = flows.get(state);
      if (!flow) {
        return;
      }
      flow.status = status;
      if (markOptions?.error !== undefined) {
        flow.error = markOptions.error;
      }
      if (markOptions?.errorCode !== undefined) {
        flow.errorCode = markOptions.errorCode;
      }
    },

    isExpired(flow, now = Date.now()) {
      return now - flow.createdAt > ttlMs;
    },

    readStatus(state) {
      const flow = flows.get(state);
      if (!flow) {
        return undefined;
      }
      const report: PendingFlowStatusReport = { status: flow.status };
      if (flow.error !== undefined) {
        report.error = flow.error;
      }
      if (flow.errorCode !== undefined) {
        report.errorCode = flow.errorCode;
      }
      return report;
    },

    cleanupExpired() {
      const cutoff = Date.now() - ttlMs;
      for (const [state, flow] of flows) {
        if (flow.createdAt < cutoff) {
          flows.delete(state);
        }
      }
    },
  };
}
