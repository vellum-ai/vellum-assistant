/**
 * Shared module mock for `permissions/gateway-threshold-reader`.
 *
 * `mock.module` registrations are process-global and last-one-wins, so files
 * that each stubbed this module their own way overwrote each other depending
 * on load order — a file could pass alone and fail in a batch (or worse, pass
 * for the wrong reason) because a sibling's stub was the one actually live.
 *
 * Every file registers this same delegating mock instead and steers it by
 * writing to {@link thresholdReaderMock}. Which registration wins no longer
 * changes behaviour, so the stubs a test sets are the stubs it gets.
 *
 * Holds no production imports — only mutable state the mock reads — so it is
 * safe to load from preload-time test machinery.
 */
import { mock } from "bun:test";

/** What the mocked cell lookup resolves to. `ok: false` is a transport failure. */
export type MockCellResult =
  | { ok: true; resolved: { threshold: string; scope: string } | null }
  | { ok: false };

export interface ThresholdReaderMockState {
  /** Resolved by `getAutoApproveThreshold`. */
  threshold: string | undefined;
  /** Resolved by `refreshAutoApproveThreshold`; `null` means "refresh failed". */
  refreshed: string | null;
  /** Resolved by `resolveChannelPermissionCell`. */
  cell: MockCellResult;
  /** The collapsed-global room default `channelNoCellDefault` derives. */
  roomDefault: string | undefined;
  /** Every `getAutoApproveThreshold` call, in order. */
  thresholdReads: Array<{
    conversationId?: string;
    executionContext?: string;
    cellQuery?: Record<string, unknown>;
  }>;
  /** Resolved by `getContactAutoApproveThreshold`. */
  contactThreshold: string | null;
  /** How many times the cell was looked up. */
  cellLookups: number;
}

export const thresholdReaderMock: ThresholdReaderMockState = {
  threshold: undefined,
  refreshed: null,
  cell: { ok: true, resolved: null },
  roomDefault: "low",
  thresholdReads: [],
  contactThreshold: null,
  cellLookups: 0,
};

/**
 * Restore the defaults: no cell anywhere, a Conservative room default,
 * failed refresh, no recorded calls.
 */
export function resetThresholdReaderMock(): void {
  thresholdReaderMock.threshold = undefined;
  thresholdReaderMock.refreshed = null;
  thresholdReaderMock.cell = { ok: true, resolved: null };
  thresholdReaderMock.roomDefault = "low";
  thresholdReaderMock.thresholdReads.length = 0;
  thresholdReaderMock.contactThreshold = null;
  thresholdReaderMock.cellLookups = 0;
}

/**
 * Register the mock. Call at module scope, before importing the code under
 * test. Safe to call from several files in one run — each registration
 * installs the same delegating stubs.
 */
export function installThresholdReaderMock(): void {
  mock.module("../permissions/gateway-threshold-reader.js", () => ({
    getAutoApproveThreshold: async (
      conversationId?: string,
      executionContext?: string,
      cellQuery?: Record<string, unknown>,
    ) => {
      thresholdReaderMock.thresholdReads.push({
        conversationId,
        executionContext,
        cellQuery,
      });
      return thresholdReaderMock.threshold;
    },
    refreshAutoApproveThreshold: async () => thresholdReaderMock.refreshed,
    getContactAutoApproveThreshold: async () =>
      thresholdReaderMock.contactThreshold,
    resolveChannelPermissionCell: async () => {
      thresholdReaderMock.cellLookups += 1;
      return thresholdReaderMock.cell;
    },
    // Mirrors the production guard: only a successful no-cell walk for a
    // non-guardian derives the default. Reimplemented here (three lines)
    // because this file must hold no production imports.
    channelNoCellDefault: async (cell: MockCellResult, contactType: string) => {
      if (!cell.ok || cell.resolved || contactType === "guardian") {
        return undefined;
      }
      return thresholdReaderMock.roomDefault;
    },
    _clearGlobalCacheForTesting: () => {},
  }));
}
