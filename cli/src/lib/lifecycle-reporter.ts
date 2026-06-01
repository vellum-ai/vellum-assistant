import { emitProgress } from "./desktop-progress.js";

/**
 * Sink for the human-facing and structured output of long-running lifecycle
 * operations (hatch, retire). Injecting it lets an in-process caller (e.g. a
 * desktop main process embedding these functions) observe progress without the
 * operation writing to the terminal, while the CLI keeps its existing stdout.
 */
export interface LifecycleReporter {
  /**
   * Coarse step progress. The CLI reporter mirrors this to the desktop
   * `HATCH_PROGRESS:` stdout channel.
   */
  progress(step: number, total: number, label: string): void;
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Reporter used by the CLI commands: human-readable lines to the console plus
 * structured step events on the desktop progress channel. Reproduces the exact
 * terminal output — and the `HATCH_PROGRESS:` lines under `VELLUM_DESKTOP_APP` —
 * that existing subprocess consumers parse.
 */
export const consoleLifecycleReporter: LifecycleReporter = {
  progress: (step, total, label) => emitProgress(step, total, label),
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};
