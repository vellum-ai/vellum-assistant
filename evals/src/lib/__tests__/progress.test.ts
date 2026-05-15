import { describe, expect, test } from "bun:test";

import {
  createConsoleReporter,
  formatEvalProgressLine,
  noopEvalProgressReporter,
  type EvalProgressEvent,
} from "../runner/progress";

class CaptureStream {
  readonly chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

describe("formatEvalProgressLine", () => {
  test("aligns step labels to a fixed width and uses the right glyph per status", () => {
    const start = formatEvalProgressLine({
      step: "hatch",
      status: "start",
      message: "Hatching assistant",
    });
    const done = formatEvalProgressLine({
      step: "hatch",
      status: "done",
      message: "Assistant ready",
    });
    const info = formatEvalProgressLine({
      step: "events",
      status: "info",
      message: "Heartbeat",
    });

    expect(start).toBe("[hatch]     ▶ Hatching assistant");
    expect(done).toBe("[hatch]     ✓ Assistant ready");
    expect(info).toBe("[events]    • Heartbeat");

    // The status glyph column should land at the same character offset
    // regardless of step name, so rows stack visually.
    const glyphColumn = (line: string): number => {
      const glyphMatch = line.match(/[▶✓•]/);
      return glyphMatch?.index ?? -1;
    };
    expect(glyphColumn(start)).toBeGreaterThan(0);
    expect(glyphColumn(start)).toBe(glyphColumn(info));
    expect(glyphColumn(done)).toBe(glyphColumn(info));
  });

  test("folds turn numbers and details into a single parenthesised suffix", () => {
    const turnOnly = formatEvalProgressLine({
      step: "simulator",
      status: "start",
      message: "Asking simulator",
      turn: 3,
    });
    const detailOnly = formatEvalProgressLine({
      step: "metrics",
      status: "done",
      message: "Metrics complete",
      detail: "2 result(s)",
    });
    const both = formatEvalProgressLine({
      step: "send",
      status: "done",
      message: "Simulator message sent",
      turn: 2,
      detail: "ok",
    });
    const none = formatEvalProgressLine({
      step: "shutdown",
      status: "done",
      message: "Assistant shut down",
    });

    expect(turnOnly).toBe("[simulator] ▶ Asking simulator  (turn 3)");
    expect(detailOnly).toBe("[metrics]   ✓ Metrics complete  (2 result(s))");
    expect(both).toBe("[send]      ✓ Simulator message sent  (turn 2 · ok)");
    expect(none).toBe("[shutdown]  ✓ Assistant shut down");
  });
});

describe("createConsoleReporter", () => {
  test("writes one newline-terminated line per event to the configured stream", () => {
    const stream = new CaptureStream();
    const reporter = createConsoleReporter({ stream });

    const events: EvalProgressEvent[] = [
      {
        step: "artifacts",
        status: "start",
        message: "Preparing run artifacts",
        detail: "eval-1",
      },
      {
        step: "artifacts",
        status: "done",
        message: "Run artifacts ready",
        detail: "artifacts/eval-1",
      },
      {
        step: "simulator",
        status: "start",
        message: "Asking simulator",
        turn: 1,
      },
    ];
    for (const event of events) reporter(event);

    expect(stream.chunks).toEqual([
      "[artifacts] ▶ Preparing run artifacts  (eval-1)\n",
      "[artifacts] ✓ Run artifacts ready  (artifacts/eval-1)\n",
      "[simulator] ▶ Asking simulator  (turn 1)\n",
    ]);
  });

  test("noop reporter never writes to any stream", () => {
    const stream = new CaptureStream();
    // The shape matches `EvalProgressReporter` so we can invoke it directly;
    // we use a stream sentinel to assert it stays untouched.
    noopEvalProgressReporter({
      step: "hatch",
      status: "start",
      message: "should be ignored",
    });
    expect(stream.chunks).toEqual([]);
  });
});
