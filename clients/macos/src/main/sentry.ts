import * as Sentry from "@sentry/node";
import { app } from "electron";

import { onSettingChange, readSetting, writeSetting } from "./settings";

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

/**
 * Read consent from electron-store. Strict opt-in: absent or false → OFF.
 */
function readConsent(): boolean {
  return readSetting("shareDiagnostics") === true;
}

/**
 * Initialize Sentry for the Electron main process, gated on the user's
 * Share Diagnostics consent stored in electron-store. The renderer syncs
 * its localStorage `device:share_diagnostics` value to main via the
 * `vellum:diagnostics:setShareDiagnostics` IPC channel.
 *
 * Strict opt-in semantics (matching the renderer's `sentry-control.ts`):
 *   - stored `true`  → Sentry ON  (explicit consent)
 *   - stored `false` → Sentry OFF (explicit opt-out)
 *   - absent         → Sentry OFF (no consent on record yet)
 *
 * Also installs an electron-store watcher so flipping the toggle
 * mid-session immediately enables/disables Sentry without restart.
 */
export function initSentryMain(): void {
  const options = resolveOptions();
  if (!options) return;

  if (readConsent()) {
    tryInit(options);
  }

  onSettingChange("shareDiagnostics", (newValue) => {
    if (newValue === true) {
      tryInit(options);
    } else {
      tryClose();
    }
  });
}

/**
 * Update the persisted diagnostics consent from the renderer's IPC call.
 * Triggers the `onSettingChange` watcher which handles Sentry lifecycle.
 */
export function setShareDiagnostics(enabled: boolean): void {
  writeSetting("shareDiagnostics", enabled);
}
