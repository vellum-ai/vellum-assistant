import { Writable } from "node:stream";

import type * as SentryNs from "@sentry/node";

/**
 * `@sentry/node` costs ~225ms to import and is only needed once an error/fatal
 * log actually reaches this stream. Importing it eagerly here would make merely
 * importing the logger pay that cost — and almost every module (and test file)
 * pulls the logger in transitively via `db-connection`. So load it lazily,
 * cached, on the first write.
 *
 * This costs production nothing: the daemon calls `initSentry()` at startup
 * (see `instrument.ts`), which imports `@sentry/node` long before the first
 * error log, so the dynamic import below resolves from the module cache. In
 * tests Sentry is never initialised, so it is simply never loaded through this
 * path.
 */
let sentryModule: Promise<typeof SentryNs> | null = null;
function loadSentry(): Promise<typeof SentryNs> {
  return (sentryModule ??= import("@sentry/node"));
}

function captureEntry(Sentry: typeof SentryNs, entry: Record<string, unknown>) {
  const module = (entry.module as string) ?? "unknown";
  const msg = (entry.msg as string) ?? "";

  if (entry.err && typeof entry.err === "object") {
    // Reconstruct an Error so Sentry gets a proper stack trace.
    const errObj = entry.err as {
      message?: string;
      type?: string;
      name?: string;
      stack?: string;
    };
    const error = new Error(errObj.message ?? msg);
    error.name = errObj.type ?? errObj.name ?? "Error";
    if (errObj.stack) error.stack = errObj.stack;

    Sentry.withScope((scope) => {
      scope.setTag("source", "error_log");
      scope.setTag("log_module", module);
      scope.setLevel((entry.level as number) >= 60 ? "fatal" : "error");
      if (msg) scope.setExtra("log_message", msg);
      Sentry.captureException(error);
    });
  } else {
    Sentry.withScope((scope) => {
      scope.setTag("source", "error_log");
      scope.setTag("log_module", module);
      scope.setLevel((entry.level as number) >= 60 ? "fatal" : "error");
      Sentry.captureMessage(`[${module}] ${msg}`);
    });
  }
}

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
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(chunk.toString());
      } catch {
        // Malformed entry — never block logging.
        callback();
        return;
      }
      loadSentry()
        .then((Sentry) => {
          try {
            captureEntry(Sentry, entry);
          } catch {
            // Never block logging if Sentry capture fails.
          }
          callback();
        })
        .catch(() => callback());
    },
  });
}
