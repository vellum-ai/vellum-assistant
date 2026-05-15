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
  /**
   * Clock for the per-line timestamp prefix. Defaults to `Date.now`. Injected
   * for deterministic test output.
   */
  now?: () => number;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * Format a timestamp as `YYYY-MM-DD HH:MM:SS` in the local time zone. Local
 * (rather than UTC) so it matches the wall-clock the operator is reading the
 * eval run on without needing a TZ suffix.
 */
export function formatProgressTimestamp(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const min = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

export interface FormatEvalProgressLineOptions {
  /** When set, prefix the line with `[YYYY-MM-DD HH:MM:SS] `. */
  timestamp?: Date;
}

/**
 * Format a single progress event as one line of console output.
 *
 * Layout: `[<ts>] [step      ] glyph message  suffix` — the optional `[<ts>]`
 * prefix is added when a timestamp is supplied. The `suffix` folds turn
 * numbers and details into a single trailing fragment separated by ` · `, with
 * no surrounding parentheses.
 */
export function formatEvalProgressLine(
  event: EvalProgressEvent,
  options: FormatEvalProgressLineOptions = {},
): string {
  const tsPrefix = options.timestamp
    ? `[${formatProgressTimestamp(options.timestamp)}] `
    : "";
  const label = `[${event.step}]`.padEnd(STEP_LABEL_WIDTH, " ");
  const glyph = STATUS_GLYPHS[event.status];
  const suffixParts: string[] = [];
  if (typeof event.turn === "number") {
    suffixParts.push(`turn ${event.turn}`);
  }
  if (event.detail && event.detail.length > 0) {
    suffixParts.push(event.detail);
  }
  const suffix = suffixParts.length > 0 ? `  ${suffixParts.join(" · ")}` : "";
  return `${tsPrefix}${label} ${glyph} ${event.message}${suffix}`;
}

/**
 * Build a reporter that prints one human-readable line per event to the given
 * stream. Designed for the `evals run` CLI: each line is self-contained so
 * operators can tail logs and immediately see what step the run is on. Every
 * line is prefixed with a `[YYYY-MM-DD HH:MM:SS]` wall-clock timestamp; the
 * clock source can be swapped via `options.now` for tests.
 */
export function createConsoleReporter(
  options: ConsoleReporterOptions = {},
): EvalProgressReporter {
  const stream = options.stream ?? process.stderr;
  const now = options.now ?? Date.now;
  return (event) => {
    const line = formatEvalProgressLine(event, { timestamp: new Date(now()) });
    stream.write(`${line}\n`);
  };
}
