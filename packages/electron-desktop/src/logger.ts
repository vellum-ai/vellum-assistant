import log from "electron-log/main";

/**
 * `stdout` and `stderr` are best-effort sinks for the console transport; the
 * rotating log file is the sink that matters. When the descriptor the app
 * inherited dies under it (a terminal that goes away fails writes with `EIO`,
 * a closed pipe with `EPIPE`), the failure arrives as an `error` event on the
 * stream rather than a throw from `console.*`, so neither the transport's own
 * try/catch nor a caller's can absorb it.
 *
 * Unlistened, that event becomes an `uncaughtException`, and the handler that
 * reports it writes the report to the same dead descriptor: every log line
 * raises another one, and each raises a modal "A JavaScript error occurred in
 * the main process" box. A listener keeps the failed write inert, and dropping
 * the console transport stops feeding a descriptor that will reject every
 * subsequent write.
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
