import { describe, expect, test } from "bun:test";

import {
  createStreamGapMonitor,
  MAX_GAP_REPORTS_PER_CALL,
  type StreamGapReport,
} from "./stream-gap-monitor.js";

function makeMonitor(thresholdMs = 500) {
  const reports: StreamGapReport[] = [];
  let clock = 0;
  const monitor = createStreamGapMonitor({
    thresholdMs,
    now: () => clock,
    onReport: (report) => reports.push(report),
  });
  return {
    reports,
    deltaAt(at: number, kind: "text" | "thinking" = "text") {
      clock = at;
      monitor.onDelta(kind);
    },
  };
}

describe("createStreamGapMonitor", () => {
  test("first delta only starts the clock", () => {
    const m = makeMonitor();
    m.deltaAt(10_000);
    expect(m.reports).toEqual([]);
  });

  test("sub-threshold gaps stay silent", () => {
    const m = makeMonitor();
    m.deltaAt(0);
    m.deltaAt(100);
    m.deltaAt(599); // 499ms gap
    expect(m.reports).toEqual([]);
  });

  test("a gap at the threshold reports with kinds and index", () => {
    const m = makeMonitor();
    m.deltaAt(0, "thinking");
    m.deltaAt(500, "text");
    expect(m.reports).toEqual([
      {
        gapMs: 500,
        kind: "text",
        prevKind: "thinking",
        deltaIndex: 2,
        suppressingFurtherReports: false,
      },
    ]);
  });

  test("gap is measured from the previous delta, not the report", () => {
    const m = makeMonitor();
    m.deltaAt(0);
    m.deltaAt(1_000);
    m.deltaAt(1_050);
    m.deltaAt(2_300);
    expect(m.reports.map((r) => r.gapMs)).toEqual([1000, 1250]);
  });

  test("threshold override is respected", () => {
    const m = makeMonitor(50);
    m.deltaAt(0);
    m.deltaAt(60);
    expect(m.reports).toHaveLength(1);
    expect(m.reports[0]?.gapMs).toBe(60);
  });

  test("reports are capped per call and the cap is flagged", () => {
    const m = makeMonitor();
    let at = 0;
    m.deltaAt(at);
    for (let i = 0; i < MAX_GAP_REPORTS_PER_CALL + 5; i++) {
      at += 1_000;
      m.deltaAt(at);
    }
    expect(m.reports).toHaveLength(MAX_GAP_REPORTS_PER_CALL);
    expect(m.reports.at(-1)?.suppressingFurtherReports).toBe(true);
    expect(
      m.reports.slice(0, -1).every((r) => !r.suppressingFurtherReports),
    ).toBe(true);
  });
});
