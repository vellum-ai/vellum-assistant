import * as Sentry from "@sentry/electron/main";
import { app } from "electron";

import { onSettingChange, readSetting, writeSetting } from "./settings";

declare const __VELLUM_BUILD_SHA__: string;
declare const __VELLUM_ENVIRONMENT__: string;
declare const __SENTRY_DSN_MACOS__: string;

/**
 * Resolved Sentry init options — cached once so re-init after consent
 * change doesn't need to re-derive them.
 *
 * The default `@sentry/electron/main` integrations enable Crashpad minidump
 * capture (`sentryMinidumpIntegration`) and renderer/child process crash
 * reporting (`childProcessIntegration`), so native main/renderer crashes
 * (OOM, segfault) upload real minidumps instead of reason-strings.
 */
function resolveOptions(): Sentry.ElectronMainOptions | null {
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

function tryInit(options: Sentry.ElectronMainOptions): void {
  const existing = Sentry.getClient();
  if (existing && existing.getOptions().enabled !== false) return;
  Sentry.init({ ...options, enabled: true });
  applyTags();
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
 * Share Diagnostics consent stored in electron-store. The renderer syncs an
 * effective diagnostics gate (preference && version-current) to main via the
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
