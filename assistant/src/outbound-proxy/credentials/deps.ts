/**
 * Injectable dependencies for credential modules.
 *
 * The credential logic is environment-agnostic. Host processes (assistant,
 * standalone proxy) call the `configure*` setters at startup to wire in
 * their concrete implementations of secure storage, logging, etc.
 *
 * Default implementations are safe no-ops so the modules can be imported
 * without configuration (e.g. for type-only imports or unit tests that
 * stub individual functions).
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── File system helpers (self-contained defaults) ──────────────────────

/** Create a directory (and parents) if it doesn't already exist. */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Read a UTF-8 text file, returning null if it doesn't exist or is unreadable. */
export function readTextFileSync(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

// ── Data directory ─────────────────────────────────────────────────────

let _getDataDir: () => string = () =>
  join(homedir(), ".vellum", "workspace", "data");

export function getDataDir(): string {
  return _getDataDir();
}

/** Override the data directory provider (call once at startup). */
export function configureGetDataDir(fn: () => string): void {
  _getDataDir = fn;
}

// ── Secure key access ──────────────────────────────────────────────────

let _getSecureKey: (account: string) => string | undefined = () => undefined;

export function getSecureKey(account: string): string | undefined {
  return _getSecureKey(account);
}

/** Override the secure key provider (call once at startup). */
export function configureGetSecureKey(
  fn: (account: string) => string | undefined,
): void {
  _getSecureKey = fn;
}

// ── Logger ─────────────────────────────────────────────────────────────

export interface CredentialLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  debug?(obj: Record<string, unknown>, msg?: string): void;
}

const noopLogger: CredentialLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

let _getLogger: (name: string) => CredentialLogger = () => noopLogger;

/**
 * Return a lazy logger proxy that delegates to the current `_getLogger`
 * factory on every method call. This ensures module-level `const log =
 * getLogger(...)` captures a wrapper that picks up a real logger even
 * when `configureGetLogger()` is called after module evaluation.
 */
export function getLogger(name: string): CredentialLogger {
  return {
    info(obj: Record<string, unknown>, msg?: string) {
      _getLogger(name).info(obj, msg);
    },
    warn(obj: Record<string, unknown>, msg?: string) {
      _getLogger(name).warn(obj, msg);
    },
    error(obj: Record<string, unknown>, msg?: string) {
      _getLogger(name).error(obj, msg);
    },
    debug(obj: Record<string, unknown>, msg?: string) {
      _getLogger(name).debug?.(obj, msg);
    },
  };
}

/** Override the logger factory (call once at startup). */
export function configureGetLogger(
  fn: (name: string) => CredentialLogger,
): void {
  _getLogger = fn;
}

// ── Post-connect hook provider ─────────────────────────────────────────

export interface PostConnectHookContext {
  service: string;
  rawTokenResponse: Record<string, unknown>;
}

type PostConnectHook = (ctx: PostConnectHookContext) => Promise<void>;

let _postConnectHooks: Record<string, PostConnectHook> = {};

export function getPostConnectHooks(): Record<string, PostConnectHook> {
  return _postConnectHooks;
}

/** Register post-connect hooks (call once at startup). */
export function configurePostConnectHooks(
  hooks: Record<string, PostConnectHook>,
): void {
  _postConnectHooks = hooks;
}
