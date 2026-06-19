import * as Sentry from "@sentry/node";
import { app } from "electron";

import { onSettingChange, writeSetting } from "./settings";

declare const __VELLUM_BUILD_SHA__: string;
declare const __VELLUM_ENVIRONMENT__: string;
declare const __SENTRY_DSN_MACOS__: string;

/**
 * Resolved Sentry init options — cached once so re-init after consent
 * change doesn't need to re-derive them.
 */
function resolveOptions(): Sentry.NodeOptions | null {
  const dsn =
    typeof __SENTRY_DSN_MACOS__ === "string" ? __SENTRY_DSN_MACOS__ : "";
  if (!dsn) return null;

  const environment =
    typeof __VELLUM_ENVIRONMENT__ === "string"
      ? __VELLUM_ENVIRONMENT__
      : "production";

  const release =
    typeof __VELLUM_BUILD_SHA__ === "string" ? __VELLUM_BUILD_SHA__ : undefined;

  return { dsn, environment, release, tracesSampleRate: 0, attachStacktrace: true };
}

function applyTags(): void {
  Sentry.setTag("process", "main");
  Sentry.setTag("arch", process.arch);
  Sentry.setTag("electron", process.versions.electron ?? "unknown");
  Sentry.setTag("packaged", String(app.isPackaged));
}

function installCrashListeners(): void {
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

let listenersInstalled = false;

function tryInit(options: Sentry.NodeOptions): void {
  const existing = Sentry.getClient();
  if (existing && existing.getOptions().enabled !== false) return;
  Sentry.init({ ...options, enabled: true });
  applyTags();
  if (!listenersInstalled) {
    installCrashListeners();
    listenersInstalled = true;
  }
}

function tryClose(): void {
  const client = Sentry.getClient();
  if (!client) return;
  void client.close(2000);
  Sentry.getCurrentScope().setClient(undefined);
}

let cachedOptions: Sentry.NodeOptions | null = null;

function applyConsent(enabled: boolean): void {
  if (!cachedOptions) return;
  if (enabled) {
    tryInit(cachedOptions);
  } else {
    tryClose();
  }
}

/**
 * Prepare main-process Sentry consent gating, starting fail-closed: Sentry is
 * NOT initialized from the persisted `shareDiagnostics` value, because main
 * boots before any renderer exists and the persisted value can be a stale
 * opt-in from a prior signed-in run. The renderer owns the live-session gate
 * and pushes the effective consent over the
 * `vellum:diagnostics:setShareDiagnostics` IPC channel; until it does, main
 * stays silent. An electron-store watcher keeps Sentry in sync with later
 * mid-session toggles.
 */
export function initSentryMain(): void {
  cachedOptions = resolveOptions();
  if (!cachedOptions) return;

  onSettingChange("shareDiagnostics", (newValue) => {
    applyConsent(newValue === true);
  });
}

/**
 * Apply the renderer's effective (session-gated) diagnostics consent: persist
 * it and enable/disable Sentry immediately. Applied directly rather than via
 * the change watcher so an unchanged persisted value still enforces the gate
 * (electron-store's `onDidChange` does not fire when the value is unchanged).
 */
export function setShareDiagnostics(enabled: boolean): void {
  writeSetting("shareDiagnostics", enabled);
  applyConsent(enabled);
}
