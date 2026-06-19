import { readdirSync, unlinkSync } from "node:fs";
import path from "node:path";

import * as Sentry from "@sentry/electron/main";
import { app } from "electron";

import { onSettingChange, writeSetting } from "./settings";

declare const __VELLUM_BUILD_SHA__: string;
declare const __VELLUM_ENVIRONMENT__: string;
declare const __SENTRY_DSN_MACOS__: string;

/**
 * Resolved Sentry init options — cached once so the first consented enable
 * doesn't need to re-derive them.
 *
 * The default `@sentry/electron/main` integrations enable Crashpad minidump
 * capture (`sentryMinidumpIntegration`) and renderer/child process crash
 * reporting (`childProcessIntegration`), so native main/renderer crashes
 * (OOM, segfault) upload real minidumps instead of reason-strings. Those
 * minidumps are uploaded via `core.captureEvent`, so they pass through
 * `beforeSend` and respect `client.getOptions().enabled` (see syncNativeGate).
 *
 * `ipcMode` is forced to `Classic`: the default (`Both`) installs a custom
 * protocol scheme via `configureProtocol`, which throws if `init()` runs after
 * the app `ready` event. We init lazily on first consent (always post-`ready`),
 * and the protocol channel is unused anyway (no renderer-side Sentry SDK), so
 * Classic IPC is both required and sufficient.
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

  return {
    dsn,
    environment,
    release,
    tracesSampleRate: 0,
    attachStacktrace: true,
    ipcMode: Sentry.IPCMode.Classic,
  };
}

function applyTags(): void {
  Sentry.setTag("process", "main");
  Sentry.setTag("arch", process.arch);
  Sentry.setTag("electron", process.versions.electron ?? "unknown");
  Sentry.setTag("packaged", String(app.isPackaged));
}

let cachedOptions: Sentry.ElectronMainOptions | null = null;
// Whether the SDK has been initialized this process. `@sentry/electron/main`
// init() starts Crashpad and installs crash listeners that close() does NOT
// remove, so an off→on→off churn of init/close would leak stale listeners.
// We init AT MOST ONCE (lazily, on first consent) and thereafter gate event
// delivery via the `enabled` flag below rather than tearing the client down.
let initialized = false;
// Live consent flag consulted by `beforeSend`: JS events are dropped while
// false. Native Crashpad minidump events also pass through `beforeSend` (they
// are captured via core.captureEvent), so this flag gates them too.
let enabled = false;

/**
 * Initialize the SDK exactly once, on the first time consent is enabled. After
 * this, toggling consent only flips the `enabled` flag — the client is never
 * closed or re-inited, so crash listeners are installed at most once.
 */
function ensureInitialized(): void {
  if (initialized || !cachedOptions) return;
  Sentry.init({
    ...cachedOptions,
    enabled: true,
    beforeSend: (event) => (enabled ? event : null),
  });
  applyTags();
  initialized = true;
}

/**
 * Fail-closed native gate: keep `client.getOptions().enabled` in sync with the
 * live consent flag. The minidump integration reads this at crash time —
 * when false it deletes queued minidumps (including pre-consent dumps surfaced
 * on a later launch) instead of uploading, and the transport short-circuits.
 * Combined with `beforeSend`, no native minidump leaves the app while opted out.
 */
function syncNativeGate(consented: boolean): void {
  const options = Sentry.getClient()?.getOptions();
  if (options) options.enabled = consented;
}

/**
 * Directories the installed `@sentry/electron` minidump loader scans on its
 * startup sweep (darwin). Mirrors getMinidumpLoader() in
 * `@sentry/electron/main/integrations/sentry-minidump/minidump-loader.js`:
 * Crashpad writes completed/pending `.dmp` files under `crashDumps`, and the
 * loader uploads any it finds (via core.captureEvent) on the next init when
 * `enabled !== false`.
 */
function queuedMinidumpDirs(): string[] {
  const crashDumps = app.getPath("crashDumps");
  return [path.join(crashDumps, "completed"), path.join(crashDumps, "pending")];
}

/**
 * Fail-closed disk gate for the never-initialized case. When consent is false
 * and the SDK was never initialized (e.g. the first effective consent after a
 * restart is false), there is no client to run the minidump integration's
 * delete-on-disabled startup scan — `Sentry.init({ enabled: false })` does NOT
 * set up integrations, so the scan never installs. Without this, Crashpad
 * dumps written during the opted-out session persist on disk and a LATER
 * opt-in's init would scan and upload them. We delete them ourselves so a
 * minidump captured while opted out can never be exfiltrated by a later opt-in.
 */
function purgeQueuedMinidumps(): void {
  for (const dir of queuedMinidumpDirs()) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".dmp")) continue;
      try {
        unlinkSync(path.join(dir, entry));
      } catch {
        // Best effort: a dump we cannot delete here is still gated by the
        // native `enabled` flag once a client exists.
      }
    }
  }
}

function applyConsent(consented: boolean): void {
  if (!cachedOptions) return;
  enabled = consented;
  if (consented) {
    ensureInitialized();
    syncNativeGate(consented);
    return;
  }
  // Opted out. If a client exists, its minidump integration deletes queued
  // dumps when the native gate is false. If not (never initialized — fail-
  // closed boot, or first consent after restart is false), no integration
  // runs, so we purge the queued dumps from disk ourselves.
  if (Sentry.getClient()) syncNativeGate(consented);
  else purgeQueuedMinidumps();
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
 * it and apply consent immediately. Applied directly rather than via the change
 * watcher so an unchanged persisted value still enforces the gate (electron-
 * store's `onDidChange` does not fire when the value is unchanged).
 */
export function setShareDiagnostics(enabledValue: boolean): void {
  writeSetting("shareDiagnostics", enabledValue);
  applyConsent(enabledValue);
}
