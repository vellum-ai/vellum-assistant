import log from "electron-log/main";

/**
 * A failed write to stdout/stderr surfaces as an `error` event on the stream a
 * tick later, not as a throw from `console.*`, so no try/catch around the log
 * call can absorb it. Unlistened it becomes an `uncaughtException`, and the
 * handler that reports it writes the report to the same dead descriptor, so
 * each report raises the next one behind a modal error box.
 *
 * The rotating log file is the sink that matters, so a descriptor that starts
 * rejecting writes costs the console transport rather than the process.
 */
function keepStdioFailuresNonFatal(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", () => {
      log.transports.console.level = false;
    });
  }
}

keepStdioFailuresNonFatal();

log.initialize({ preload: true });

log.transports.file.maxSize = 10 * 1024 * 1024; // 10 MB
log.transports.file.fileName = "vellum.log";
log.transports.file.format =
  "[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] [{processType}] {text}";

export default log;

export const getLogFilePaths = (): string[] => [
  log.transports.file.getFile().path,
];
