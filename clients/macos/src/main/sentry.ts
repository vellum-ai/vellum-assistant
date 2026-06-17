import * as Sentry from "@sentry/node";
import { app } from "electron";

declare const __VELLUM_BUILD_SHA__: string;
declare const __VELLUM_ENVIRONMENT__: string;
declare const __SENTRY_DSN_MACOS__: string;

/**
 * Initialize Sentry for the Electron main process. Reports to the
 * `vellum-assistant-macos` Sentry project. The renderer (clients/web)
 * initializes its own `@sentry/react` instance reporting to
 * `vellum-assistant-web`; the two are independent.
 *
 * Must be called as early as possible — before `app.whenReady()` — so
 * that unhandled exceptions and promise rejections during startup are
 * captured.
 */
export function initSentryMain(): void {
  const dsn =
    typeof __SENTRY_DSN_MACOS__ === "string" ? __SENTRY_DSN_MACOS__ : "";
  if (!dsn) return;

  const environment =
    typeof __VELLUM_ENVIRONMENT__ === "string"
      ? __VELLUM_ENVIRONMENT__
      : "production";

  const release =
    typeof __VELLUM_BUILD_SHA__ === "string" ? __VELLUM_BUILD_SHA__ : undefined;

  Sentry.init({
    dsn,
    environment,
    release,
    tracesSampleRate: 0,
    attachStacktrace: true,
  });

  Sentry.setTag("process", "main");
  Sentry.setTag("arch", process.arch);
  Sentry.setTag("electron", process.versions.electron ?? "unknown");
  Sentry.setTag("packaged", String(app.isPackaged));

  app.on("render-process-gone", (_event, _webContents, details) => {
    if (details.reason === "clean-exit") return;
    Sentry.captureMessage(`Renderer process gone: ${details.reason}`, {
      level: "fatal",
      extra: { exitCode: details.exitCode, reason: details.reason },
    });
  });

  app.on("child-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    Sentry.captureMessage(
      `Child process gone: ${details.type} (${details.reason})`,
      {
        level: "error",
        extra: {
          type: details.type,
          reason: details.reason,
          exitCode: details.exitCode,
        },
      },
    );
  });
}
