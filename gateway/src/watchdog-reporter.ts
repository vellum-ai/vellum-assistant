// Shared scaffolding for fail-loud watchdog reporters: per-key hourly rate
// limiting, an error-level log, and a fire-and-forget relay to the daemon's
// internal watchdog telemetry route. Best-effort — never throws, never blocks
// the caller, and a lost event is acceptable for rare, high-signal checks (no
// retry). Each reporter module owns its check names, message copy, and detail
// shaping; this factory owns the state and transport posture.

import { loadConfig } from "./config.js";
import type { fetchImpl } from "./fetch.js";
import { postInternalTelemetry } from "./internal-telemetry-client.js";

const ROUTE_PATH = "/v1/internal/telemetry/watchdog";
const REPORT_INTERVAL_MS = 60 * 60 * 1000;

export type ReporterLog = {
  error: (detail: Record<string, unknown>, msg: string) => void;
  warn: (detail: Record<string, unknown>, msg: string) => void;
};

export type ReporterOverrides = {
  fetchImpl?: typeof fetchImpl;
  mintToken?: () => string;
  baseUrl?: string;
  log?: ReporterLog;
};

export type WatchdogReport = {
  /** Rate-limit key: at most one report per key per hour per process. */
  key: string;
  /** Watchdog `check_name` — the cross-repo platform-dashboard contract. */
  checkName: string;
  /** Error-log message. */
  message: string;
  /** Logged with the error and sent as the relay body's `detail`. */
  detail: Record<string, unknown>;
  /** Merged into the non-fatal relay warn logs. */
  warnContext: Record<string, unknown>;
};

export type WatchdogReporter = {
  report: (args: WatchdogReport) => void;
  /**
   * Test-only: inject fetch/token/baseUrl/log so tests never touch the
   * network or the process logger.
   */
  setOverridesForTesting: (next: ReporterOverrides) => void;
  /** Test-only: clear overrides and the rate-limit windows. */
  resetForTesting: () => void;
  /** Test-only: await the most recent fire-and-forget relay. */
  flushForTesting: () => Promise<unknown>;
};

export function createWatchdogReporter(config: {
  log: ReporterLog;
  relayFailedMessage: string;
  relayRejectedMessage: string;
}): WatchdogReporter {
  let overrides: ReporterOverrides = {};
  const lastReportAtByKey = new Map<string, number>();
  let pendingRelay: Promise<unknown> = Promise.resolve();

  const reporterLog = (): ReporterLog => overrides.log ?? config.log;

  async function relayToDaemon(args: WatchdogReport): Promise<void> {
    const resp = await postInternalTelemetry({
      baseUrl: overrides.baseUrl ?? loadConfig().assistantRuntimeBaseUrl,
      path: ROUTE_PATH,
      body: { check_name: args.checkName, detail: args.detail },
      fetchImpl: overrides.fetchImpl,
      mintToken: overrides.mintToken,
    });
    if (!resp.ok) {
      reporterLog().warn(
        { status: resp.status, ...args.warnContext },
        config.relayRejectedMessage,
      );
    }
  }

  return {
    report(args: WatchdogReport): void {
      const now = Date.now();
      const last = lastReportAtByKey.get(args.key) ?? Number.NEGATIVE_INFINITY;
      if (now - last < REPORT_INTERVAL_MS) {
        return;
      }
      lastReportAtByKey.set(args.key, now);

      reporterLog().error(args.detail, args.message);

      pendingRelay = relayToDaemon(args).catch((err) => {
        reporterLog().warn(
          { err, ...args.warnContext },
          config.relayFailedMessage,
        );
      });
    },
    setOverridesForTesting(next: ReporterOverrides): void {
      overrides = next;
    },
    resetForTesting(): void {
      overrides = {};
      lastReportAtByKey.clear();
      pendingRelay = Promise.resolve();
    },
    flushForTesting(): Promise<unknown> {
      return pendingRelay;
    },
  };
}
