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

/** Check if the OS keychain is available on this system. */
export function isKeychainAvailable(): boolean {
  try {
    if (isMacOS()) {
      // Verify `security` CLI exists and can list keychains
      execFileSync('security', ['list-keychains'], {
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 5000,
      });
      return true;
    }

    if (isLinux()) {
      // Verify `secret-tool` exists
      execFileSync('which', ['secret-tool'], {
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
 * Returns `undefined` if the key doesn't exist or the keychain is unavailable.
 */
export function getKey(account: string): string | undefined {
  try {
    if (isMacOS()) {
      return macosGetKey(account);
    }
    if (isLinux()) {
      return linuxGetKey(account);
    }
    return undefined;
  } catch (err) {
    log.debug({ err, account }, 'Failed to read from keychain');
    return undefined;
  }
}

/**
 * Store a secret in the OS keychain.
 * Returns true on success, false on failure.
 */
export function setKey(account: string, value: string): boolean {
  try {
    if (isMacOS()) {
      return macosSetKey(account, value);
    }
    if (isLinux()) {
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
    if (isMacOS()) {
      return macosDeleteKey(account);
    }
    if (isLinux()) {
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

function macosGetKey(account: string): string | undefined {
  try {
    const result = execFileSync('security', [
      'find-generic-password',
      '-s', SERVICE_NAME,
      '-a', account,
      '-w', // output password only
    ], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      encoding: 'utf-8',
    });
    return result.trim() || undefined;
  } catch {
    // Item not found (exit code 44) or other error
    return undefined;
  }
}

function macosSetKey(account: string, value: string): boolean {
  // Delete first to avoid "already exists" errors on update
  macosDeleteKey(account);
  try {
    execFileSync('security', [
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
    execFileSync('security', [
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

function linuxGetKey(account: string): string | undefined {
  try {
    const result = execFileSync('secret-tool', [
      'lookup',
      'service', SERVICE_NAME,
      'account', account,
    ], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      encoding: 'utf-8',
    });
    return result.trim() || undefined;
  } catch {
    return undefined;
  }
}

function linuxSetKey(account: string, value: string): boolean {
  try {
    execFileSync('secret-tool', [
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
    execFileSync('secret-tool', [
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
