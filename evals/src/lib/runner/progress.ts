export type EvalProgressStep =
  | "artifacts"
  | "hatch"
  | "setup"
  | "events"
  | "simulator"
  | "send"
  | "metrics"
  | "shutdown";

export interface EvalProgressEvent {
  step: EvalProgressStep;
  status: "start" | "done" | "info";
  message: string;
  detail?: string;
  turn?: number;
}

export type EvalProgressReporter = (event: EvalProgressEvent) => void;

export const noopEvalProgressReporter: EvalProgressReporter = (_event) => {
  // Intentionally empty.
};

/** Width used to align the `[step]` prefix in console output. */
const STEP_LABEL_WIDTH = 11;

const STATUS_GLYPHS: Record<EvalProgressEvent["status"], string> = {
  start: "▶",
  done: "✓",
  info: "•",
};

export interface ConsoleReporterOptions {
  /** Stream to write to. Defaults to `process.stderr` so stdout stays clean for JSON piping. */
  stream?: { write(chunk: string): unknown };
  /** Clock for timestamps. Defaults to `Date.now`. Injected for tests. */
  now?: () => number;
}

/**
 * Format a single progress event as one line of console output.
 *
 * Layout: `[step      ] glyph message  (detail)` — turn numbers fold into the
 * detail when present so each row stays a single line and aligns vertically
 * with sibling rows.
 */
export function formatEvalProgressLine(event: EvalProgressEvent): string {
  const label = `[${event.step}]`.padEnd(STEP_LABEL_WIDTH, " ");
  const glyph = STATUS_GLYPHS[event.status];
  const suffixParts: string[] = [];
  if (typeof event.turn === "number") {
    suffixParts.push(`turn ${event.turn}`);
  }
  if (event.detail && event.detail.length > 0) {
    suffixParts.push(event.detail);
  }
  const suffix = suffixParts.length > 0 ? `  (${suffixParts.join(" · ")})` : "";
  return `${label} ${glyph} ${event.message}${suffix}`;
}

/**
 * Build a reporter that prints one human-readable line per event to the given
 * stream. Designed for the `evals run` CLI: each line is self-contained so
 * users can tail logs and immediately see what step the run is on.
 */
export function createConsoleReporter(
  options: ConsoleReporterOptions = {},
): EvalProgressReporter {
  const stream = options.stream ?? process.stderr;
  return (event) => {
    stream.write(`${formatEvalProgressLine(event)}\n`);
  };
}
