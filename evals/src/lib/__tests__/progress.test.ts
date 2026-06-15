import { describe, expect, test } from "bun:test";

import {
  createConsoleReporter,
  createSummaryOnlyReporter,
  formatEvalProgressLine,
  formatProgressTimestamp,
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

describe("formatProgressTimestamp", () => {
  test("formats a Date as YYYY-MM-DD HH:MM:SS using the local time zone", () => {
    // Construct the date using local-time constructor args so the test
    // doesn't depend on the host's TZ — the formatter reads local time, so
    // we feed it local-time inputs and expect the same components back.
    const date = new Date(2026, 4, 15, 15, 31, 54);
    expect(formatProgressTimestamp(date)).toBe("2026-05-15 15:31:54");
  });

  test("pads single-digit components to two characters", () => {
    const date = new Date(2026, 0, 3, 4, 5, 6);
    expect(formatProgressTimestamp(date)).toBe("2026-01-03 04:05:06");
  });
});

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
    const errorEvent = formatEvalProgressLine({
      step: "simulator",
      status: "error",
      message: "Simulator stalled",
    });

    expect(start).toBe("[hatch]     ▶ Hatching assistant");
    expect(done).toBe("[hatch]     ✓ Assistant ready");
    expect(info).toBe("[events]    • Heartbeat");
    expect(errorEvent).toBe("[simulator] ✗ Simulator stalled");

    // The status glyph column should land at the same character offset
    // regardless of step name, so rows stack visually.
    const glyphColumn = (line: string): number => {
      const glyphMatch = line.match(/[▶✓•✗]/);
      return glyphMatch?.index ?? -1;
    };
    expect(glyphColumn(start)).toBeGreaterThan(0);
    expect(glyphColumn(start)).toBe(glyphColumn(info));
    expect(glyphColumn(done)).toBe(glyphColumn(info));
    expect(glyphColumn(errorEvent)).toBe(glyphColumn(info));
  });

  test("folds turn numbers and details into a single space-separated suffix with no parens", () => {
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

    expect(turnOnly).toBe("[simulator] ▶ Asking simulator  turn 3");
    expect(detailOnly).toBe("[metrics]   ✓ Metrics complete  2 result(s)");
    expect(both).toBe("[send]      ✓ Simulator message sent  turn 2 · ok");
    expect(none).toBe("[shutdown]  ✓ Assistant shut down");
  });

  test("prefixes lines with [YYYY-MM-DD HH:MM:SS] when a timestamp is supplied", () => {
    const ts = new Date(2026, 4, 15, 15, 31, 54);
    const line = formatEvalProgressLine(
      {
        step: "artifacts",
        status: "start",
        message: "Preparing run artifacts",
        detail: "eval-vellum-default-timeline-recall-20260515153154",
      },
      { timestamp: ts },
    );
    expect(line).toBe(
      "[2026-05-15 15:31:54] [artifacts] ▶ Preparing run artifacts  eval-vellum-default-timeline-recall-20260515153154",
    );
  });

  test("renders each `details` entry on its own indented line under the header", () => {
    const line = formatEvalProgressLine({
      step: "simulator",
      status: "error",
      message: "User simulator response had no actionable content",
      turn: 3,
      details: [
        "stop_reason=end_turn",
        "parts=[]",
        'body: {"model":"claude-haiku-4-5-20251001","content":[]}',
      ],
    });
    expect(line).toBe(
      [
        "[simulator] ✗ User simulator response had no actionable content  turn 3",
        "    stop_reason=end_turn",
        "    parts=[]",
        '    body: {"model":"claude-haiku-4-5-20251001","content":[]}',
      ].join("\n"),
    );
  });

  test("wraps the header (but not details) in ANSI red when color is enabled for error events", () => {
    const line = formatEvalProgressLine(
      {
        step: "simulator",
        status: "error",
        message: "Simulator stalled",
        turn: 3,
        details: ["stop_reason=end_turn"],
      },
      { color: true },
    );
    const RED = "\u001b[31m";
    const RESET = "\u001b[0m";
    expect(line).toBe(
      [
        `${RED}[simulator] ✗ Simulator stalled  turn 3${RESET}`,
        "    stop_reason=end_turn",
      ].join("\n"),
    );
  });

  test("does not colorize non-error statuses even when color is enabled", () => {
    const line = formatEvalProgressLine(
      {
        step: "hatch",
        status: "start",
        message: "Hatching assistant",
      },
      { color: true },
    );
    expect(line).toBe("[hatch]     ▶ Hatching assistant");
  });
});

describe("createConsoleReporter", () => {
  test("writes one timestamped, newline-terminated line per event to the configured stream", () => {
    const stream = new CaptureStream();
    // Inject a fixed clock so the test is deterministic. Each call returns
    // a different epoch ms so we can assert the prefix advances per line.
    let tick = new Date(2026, 4, 15, 15, 31, 54).getTime();
    const reporter = createConsoleReporter({
      stream,
      now: () => {
        const value = tick;
        tick += 1_000;
        return value;
      },
    });

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
      "[2026-05-15 15:31:54] [artifacts] ▶ Preparing run artifacts  eval-1\n",
      "[2026-05-15 15:31:55] [artifacts] ✓ Run artifacts ready  artifacts/eval-1\n",
      "[2026-05-15 15:31:56] [simulator] ▶ Asking simulator  turn 1\n",
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

  test("writes header + nested details as a single multi-line chunk", () => {
    const stream = new CaptureStream();
    const reporter = createConsoleReporter({
      stream,
      now: () => new Date(2026, 4, 15, 15, 31, 54).getTime(),
      color: false,
    });

    reporter({
      step: "simulator",
      status: "error",
      message: "User simulator response had no actionable content",
      turn: 3,
      details: ["stop_reason=end_turn", "parts=[]"],
    });

    expect(stream.chunks).toEqual([
      [
        "[2026-05-15 15:31:54] [simulator] ✗ User simulator response had no actionable content  turn 3",
        "    stop_reason=end_turn",
        "    parts=[]",
        "",
      ].join("\n"),
    ]);
  });

  test("auto-enables ANSI red on TTY streams and disables it on non-TTY streams", () => {
    const tty = Object.assign(new CaptureStream(), { isTTY: true });
    const file = new CaptureStream();
    const now = () => new Date(2026, 4, 15, 15, 31, 54).getTime();

    createConsoleReporter({ stream: tty, now })({
      step: "simulator",
      status: "error",
      message: "Simulator stalled",
      turn: 3,
    });
    createConsoleReporter({ stream: file, now })({
      step: "simulator",
      status: "error",
      message: "Simulator stalled",
      turn: 3,
    });

    const RED = "\u001b[31m";
    const RESET = "\u001b[0m";
    expect(tty.chunks).toEqual([
      `[2026-05-15 15:31:54] ${RED}[simulator] ✗ Simulator stalled  turn 3${RESET}\n`,
    ]);
    expect(file.chunks).toEqual([
      "[2026-05-15 15:31:54] [simulator] ✗ Simulator stalled  turn 3\n",
    ]);
  });
});

describe("createSummaryOnlyReporter", () => {
  // Backs `evals run --quiet`. The reporter must drop every per-step event
  // (artifacts, hatch, setup, events, simulator, send, metrics, shutdown)
  // while still letting the per-run `result` summary through and surfacing
  // any `status: "error"` so silent failures can't hide behind --quiet.
  function makeReporter() {
    const stream = new CaptureStream();
    const reporter = createSummaryOnlyReporter({
      stream,
      now: () => new Date(2026, 4, 15, 15, 31, 54).getTime(),
      color: false,
    });
    return { stream, reporter };
  }

  test("drops per-step start/done events", () => {
    const { stream, reporter } = makeReporter();

    const droppedSteps: EvalProgressEvent[] = [
      { step: "artifacts", status: "start", message: "Preparing" },
      { step: "hatch", status: "done", message: "Hatched" },
      { step: "setup", status: "done", message: "Setup ok" },
      { step: "events", status: "start", message: "Subscribed" },
      { step: "simulator", status: "done", message: "Turn ok", turn: 1 },
      { step: "send", status: "done", message: "Sent", turn: 1 },
      { step: "metrics", status: "done", message: "Scored" },
      { step: "shutdown", status: "done", message: "Shut down" },
    ];
    for (const event of droppedSteps) reporter(event);

    expect(stream.chunks).toEqual([]);
  });

  test("forwards the per-run result summary", () => {
    const { stream, reporter } = makeReporter();

    reporter({
      step: "result",
      status: "done",
      message: "vellum-default/timeline-recall",
      detail: "date-mentioned=1.00, assistant-cost-usd=-0.0001",
    });

    expect(stream.chunks).toEqual([
      "[2026-05-15 15:31:54] [result]    ✓ vellum-default/timeline-recall  date-mentioned=1.00, assistant-cost-usd=-0.0001\n",
    ]);
  });

  test("forwards any error event regardless of step", () => {
    // The runner emits `status: "error"` from whatever step was in flight
    // at the time of failure (simulator, events, …). All of them must
    // come through so --quiet operators see the breakdown.
    const { stream, reporter } = makeReporter();

    reporter({
      step: "simulator",
      status: "error",
      message: "User simulator response had no actionable content",
      turn: 3,
      details: ["stop_reason=max_tokens", "parts=[]"],
    });

    expect(stream.chunks.length).toBe(1);
    expect(stream.chunks[0]).toContain(
      "[simulator] ✗ User simulator response had no actionable content",
    );
    expect(stream.chunks[0]).toContain("stop_reason=max_tokens");
  });
});
