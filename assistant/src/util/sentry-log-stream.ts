import { Writable } from "node:stream";

import * as Sentry from "@sentry/node";

/**
 * Pino-compatible writable stream that forwards error/fatal log messages
 * to Sentry as captured events. Add this stream to a pino multistream at
 * the "error" level so that every `log.error(…)` and `log.fatal(…)` call
 * automatically creates a Sentry issue.
 *
 * If the log entry contains an `err` field (serialised error object), the
 * error is captured via `Sentry.captureException`; otherwise the message
 * text is captured via `Sentry.captureMessage`.
 */
export function createSentryLogStream(): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      try {
        const entry = JSON.parse(chunk.toString());
        const module: string = entry.module ?? "unknown";
        const msg: string = entry.msg ?? "";

        if (entry.err && typeof entry.err === "object") {
          // Reconstruct an Error so Sentry gets a proper stack trace.
          const errObj = entry.err;
          const error = new Error(errObj.message ?? msg);
          error.name = errObj.type ?? errObj.name ?? "Error";
          if (errObj.stack) error.stack = errObj.stack;

          Sentry.withScope((scope) => {
            scope.setTag("source", "error_log");
            scope.setTag("log_module", module);
            scope.setLevel(entry.level >= 60 ? "fatal" : "error");
            if (msg) scope.setExtra("log_message", msg);
            Sentry.captureException(error);
          });
        } else {
          Sentry.withScope((scope) => {
            scope.setTag("source", "error_log");
            scope.setTag("log_module", module);
            scope.setLevel(entry.level >= 60 ? "fatal" : "error");
            Sentry.captureMessage(`[${module}] ${msg}`);
          });
        }
      } catch {
        // Never block logging if Sentry capture fails.
      }
      callback();
    },
  });
}
