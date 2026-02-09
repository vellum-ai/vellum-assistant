/**
 * OS keychain abstraction — platform-agnostic secure credential storage.
 *
 * - macOS: uses the `security` CLI to interact with Keychain
 * - Linux: uses `secret-tool` (libsecret) for GNOME/KDE keyrings
 *
 * All operations are synchronous to match the config loader's sync API.
 * Callers should check `isKeychainAvailable()` before use and fall back
 * to encrypted-at-rest storage when the keychain is not accessible.
 */

import { execFileSync } from 'node:child_process';
import { isMacOS, isLinux } from '../util/platform.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('keychain');

const SERVICE_NAME = 'vellum-assistant';

// ---------------------------------------------------------------------------
// Injectable deps — avoids process-global mock.module for testing
// ---------------------------------------------------------------------------

const deps = {
  execFileSync: execFileSync as typeof execFileSync,
  isMacOS,
  isLinux,
};

/** @internal test-only — override deps to avoid mock.module conflicts */
export function _overrideDeps(overrides: Partial<typeof deps>): void {
  Object.assign(deps, overrides);
}

/** @internal test-only — restore original deps */
export function _resetDeps(): void {
  deps.execFileSync = execFileSync;
  deps.isMacOS = isMacOS;
  deps.isLinux = isLinux;
}

/** Check if the OS keychain is available on this system. */
export function isKeychainAvailable(): boolean {
  try {
    if (deps.isMacOS()) {
      // Verify `security` CLI exists and can list keychains
      deps.execFileSync('security', ['list-keychains'], {
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 5000,
      });
      return true;
    }

    if (deps.isLinux()) {
      // Verify `secret-tool` exists
      deps.execFileSync('which', ['secret-tool'], {
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 5000,
      });
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Retrieve a secret from the OS keychain.
 * Returns `null` if the key doesn't exist.
 * Throws on runtime errors (keychain unavailable, locked, etc.).
 */
export function getKey(account: string): string | null {
  if (deps.isMacOS()) {
    return macosGetKey(account);
  }
  if (deps.isLinux()) {
    return linuxGetKey(account);
  }
  return null;
}

/**
 * Store a secret in the OS keychain.
 * Returns true on success, false on failure.
 */
export function setKey(account: string, value: string): boolean {
  try {
    if (deps.isMacOS()) {
      return macosSetKey(account, value);
    }
    if (deps.isLinux()) {
      return linuxSetKey(account, value);
    }
    return false;
  } catch (err) {
    log.warn({ err, account }, 'Failed to write to keychain');
    return false;
  }
}

/**
 * Delete a secret from the OS keychain.
 * Returns true on success, false if not found or on failure.
 */
export function deleteKey(account: string): boolean {
  try {
    if (deps.isMacOS()) {
      return macosDeleteKey(account);
    }
    if (deps.isLinux()) {
      return linuxDeleteKey(account);
    }
    return false;
  } catch (err) {
    log.debug({ err, account }, 'Failed to delete from keychain');
    return false;
  }
}

// ---------------------------------------------------------------------------
// macOS Keychain via `security` CLI
// ---------------------------------------------------------------------------

function macosGetKey(account: string): string | null {
  try {
    const result = deps.execFileSync('security', [
      'find-generic-password',
      '-s', SERVICE_NAME,
      '-a', account,
      '-w', // output password only
    ], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      encoding: 'utf-8',
    });
    // Strip only the trailing newline added by the security CLI
    return result.replace(/\n$/, '') || null;
  } catch (err: unknown) {
    // Exit code 44 = item not found — return null.
    // All other errors are runtime failures — re-throw.
    if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 44) {
      return null;
    }
    throw err;
  }
}

function macosSetKey(account: string, value: string): boolean {
  // -U flag handles update-if-exists, no need to delete first.
  // macOS `security` requires the password as the argument to -w;
  // it does NOT read from stdin. Using `-w` without a value causes
  // the next flag to be consumed as the password.
  try {
    deps.execFileSync('security', [
      'add-generic-password',
      '-s', SERVICE_NAME,
      '-a', account,
      '-w', value,
      '-U', // update if exists
    ], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

function macosDeleteKey(account: string): boolean {
  try {
    deps.execFileSync('security', [
      'delete-generic-password',
      '-s', SERVICE_NAME,
      '-a', account,
    ], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Linux via `secret-tool` (libsecret)
// ---------------------------------------------------------------------------

function linuxGetKey(account: string): string | null {
  try {
    const result = deps.execFileSync('secret-tool', [
      'lookup',
      'service', SERVICE_NAME,
      'account', account,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
      encoding: 'utf-8',
    });
    // Strip only the trailing newline added by secret-tool
    return result.replace(/\n$/, '') || null;
  } catch (err: unknown) {
    // secret-tool exits with code 1 for BOTH "not found" and runtime errors
    // (D-Bus failures, keyring locked, etc.). Distinguish by checking stderr:
    // empty stderr → key not found; non-empty stderr → runtime error.
    if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 1) {
      const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim();
      if (stderr.length > 0) {
        throw err;
      }
      return null;
    }
    throw err;
  }
}

function linuxSetKey(account: string, value: string): boolean {
  try {
    deps.execFileSync('secret-tool', [
      'store',
      '--label', `${SERVICE_NAME}: ${account}`,
      'service', SERVICE_NAME,
      'account', account,
    ], {
      input: value,
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

function linuxDeleteKey(account: string): boolean {
  try {
    deps.execFileSync('secret-tool', [
      'clear',
      'service', SERVICE_NAME,
      'account', account,
    ], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}
