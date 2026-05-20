export type EvalProgressStep =
  | "artifacts"
  | "hatch"
  | "setup"
  | "events"
  | "simulator"
  | "send"
  | "metrics"
  | "shutdown"
  // Emitted once per run after metrics finish. Carries the per-metric score
  // summary in `detail` so the CLI logs the aggregated outcome inline with
  // every other step. Replaces the previous `console.log(JSON.stringify(...))`
  // dump on stdout that mixed run output with JSON noise.
  | "result";

export interface EvalProgressEvent {
  step: EvalProgressStep;
  status: "start" | "done" | "info" | "error";
  message: string;
  detail?: string;
  /**
   * Extra lines to render directly under the header line, indented to nest
   * visually beneath the message. Use for failure breakdowns (one entry per
   * diagnostic line: stop_reason, parts summary, raw body, …) so each piece
   * stands on its own scannable row instead of one long flat string.
   */
  details?: string[];
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
  error: "✗",
};

/** ANSI SGR sequences for colorizing the `error` status header on TTY streams. */
const ANSI_RED = "\u001b[31m";
const ANSI_RESET = "\u001b[0m";

/** Indent applied to nested `details` lines, sized to nest under the header glyph. */
const DETAIL_INDENT = "    ";

export interface ConsoleReporterOptions {
  /** Stream to write to. Defaults to `process.stderr` so stdout stays reserved for explicit command output. */
  stream?: { write(chunk: string): unknown; isTTY?: boolean };
  /**
   * Clock for the per-line timestamp prefix. Defaults to `Date.now`. Injected
   * for deterministic test output.
   */
  now?: () => number;
  /**
   * Force-enable or force-disable ANSI color escapes. When undefined, color is
   * applied iff the underlying stream reports `isTTY === true`. Tests set this
   * explicitly so they don't depend on the host's terminal capabilities.
   */
  color?: boolean;
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
  /**
   * When true, wrap the header line of `status: "error"` events in ANSI red
   * SGR escapes. Detail lines stay uncolored so the raw JSON body in failure
   * diagnostics remains greppable. Defaults to false.
   */
  color?: boolean;
}

/**
 * Format a single progress event as one or more lines of console output.
 *
 * Layout for the header line:
 *   `[<ts>] [step      ] glyph message  suffix`
 *
 * The optional `[<ts>]` prefix is added when a timestamp is supplied. The
 * `suffix` folds turn numbers and details into a single trailing fragment
 * separated by ` · `, with no surrounding parentheses. When `event.details`
 * is non-empty, each entry is rendered on its own line, indented to nest
 * visually beneath the header. When `options.color` is true and the event
 * status is `"error"`, the header line is wrapped in ANSI red.
 *
 * The return value never includes a trailing newline — callers append one if
 * they're writing to a stream.
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
  const headerCore = `${label} ${glyph} ${event.message}${suffix}`;
  const colorize = options.color === true && event.status === "error";
  const header = colorize
    ? `${tsPrefix}${ANSI_RED}${headerCore}${ANSI_RESET}`
    : `${tsPrefix}${headerCore}`;
  const detailLines = (event.details ?? []).map(
    (line) => `${DETAIL_INDENT}${line}`,
  );
  return detailLines.length > 0 ? [header, ...detailLines].join("\n") : header;
}

/**
 * Build a reporter that prints one human-readable record per event to the
 * given stream. Designed for the `evals run` CLI: each record is
 * self-contained so operators can tail logs and immediately see what step the
 * run is on. The header line is prefixed with a `[YYYY-MM-DD HH:MM:SS]`
 * wall-clock timestamp; the clock source can be swapped via `options.now` for
 * tests. `error` events emit a red header with diagnostic `details` lines
 * indented beneath it on TTY streams; non-TTY streams (CI logs, redirects)
 * stay uncolored unless `options.color` overrides the detection.
 */
export function createConsoleReporter(
  options: ConsoleReporterOptions = {},
): EvalProgressReporter {
  const stream = options.stream ?? process.stderr;
  const now = options.now ?? Date.now;
  const color =
    options.color ??
    (typeof stream === "object" && stream !== null && stream.isTTY === true);
  return (event) => {
    const line = formatEvalProgressLine(event, {
      timestamp: new Date(now()),
      color,
    });
    stream.write(`${line}\n`);
  };
}

/**
 * Build a reporter that only surfaces the per-run summary (the `result` step)
 * and any failure (`status: "error"`). Per-step progress chatter is dropped.
 *
 * Backs `evals run --quiet`: operators still want one line per run telling
 * them whether the profile/test combo succeeded and what scores it produced,
 * but don't want the artifacts/hatch/setup/events/simulator/send/metrics/
 * shutdown stream cluttering CI logs. Errors still come through so a silent
 * failure can never hide behind `--quiet`.
 */
export function createSummaryOnlyReporter(
  options: ConsoleReporterOptions = {},
): EvalProgressReporter {
  const inner = createConsoleReporter(options);
  return (event) => {
    if (event.step === "result" || event.status === "error") inner(event);
  };
}
