/**
 * Headless cookie extraction from Chrome's local SQLite database.
 * Extracts Amazon session cookies without any visible browser window or user interaction.
 */

import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtractedCredential } from "./client.js";
import type { AmazonSession } from "./session.js";

const CHROME_COOKIES_DB = join(
  homedir(),
  "Library/Application Support/Google/Chrome/Default/Cookies",
);

/**
 * Decrypt a Chrome cookie encrypted_value blob on macOS.
 * Chrome uses AES-128-CBC with a key derived from the Keychain password via PBKDF2.
 * The encrypted blob is prefixed with 'v10' (3 bytes).
 */
function decryptChromeCookie(
  encHex: string,
  derivedKey: Buffer,
): string | null {
  const buf = Buffer.from(encHex, "hex");
  if (buf.length < 4 || buf.slice(0, 3).toString() !== "v10") return null;
  try {
    const iv = Buffer.alloc(16, 0x20); // Chrome uses 16 space characters as IV
    const decipher = crypto.createDecipheriv("aes-128-cbc", derivedKey, iv);
    const decrypted = Buffer.concat([
      decipher.update(buf.slice(3)),
      decipher.final(),
    ]);
    // Strip leading non-printable bytes (padding artifacts)
    const str = decrypted.toString("utf-8");
    const match = str.match(/[\x20-\x7e]+/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

/**
 * Extract Amazon session cookies directly from Chrome's local SQLite cookie database.
 * No visible Chrome window or user interaction required.
 *
 * Requirements:
 *   - Chrome must be installed with a Default profile
 *   - The user must be signed into Amazon in Chrome
 *   - macOS Keychain access for 'Chrome Safe Storage' (will prompt once)
 */
export async function extractSessionFromChromeCookies(): Promise<AmazonSession> {
  // 1. Get Chrome Safe Storage key from macOS Keychain
  let keychainPassword: string;
  try {
    keychainPassword = execSync(
      'security find-generic-password -w -s "Chrome Safe Storage" -a "Chrome"',
      { encoding: "utf-8" },
    ).trim();
  } catch {
    throw new Error(
      "Could not read Chrome Safe Storage key from macOS Keychain. " +
        "Make sure Chrome is installed and has been opened at least once.",
    );
  }

  // 2. Derive the AES key using PBKDF2 (same as Chrome's implementation)
  const derivedKey = crypto.pbkdf2Sync(
    keychainPassword,
    "saltysalt",
    1003,
    16,
    "sha1",
  );

  // 3. Copy the Cookies DB to a temp file, then query the copy.
  //    Reading Chrome's live SQLite DB directly can interfere with Chrome's
  //    WAL journaling and cause session logouts. Copying first is safe.
  const tmpCookiesDb = join(tmpdir(), `vellum-chrome-cookies-${Date.now()}.db`);
  let rawOutput: string;
  try {
    copyFileSync(CHROME_COOKIES_DB, tmpCookiesDb);
    // Also copy WAL and SHM files if they exist, so the copy is consistent
    const walPath = CHROME_COOKIES_DB + "-wal";
    const shmPath = CHROME_COOKIES_DB + "-shm";
    if (existsSync(walPath)) copyFileSync(walPath, tmpCookiesDb + "-wal");
    if (existsSync(shmPath)) copyFileSync(shmPath, tmpCookiesDb + "-shm");

    rawOutput = execSync(
      `sqlite3 "${tmpCookiesDb}" "SELECT name, hex(encrypted_value), host_key, path, is_httponly, is_secure, expires_utc FROM cookies WHERE host_key LIKE '%amazon.com%'"`,
      { encoding: "utf-8" },
    ).trim();
  } catch {
    throw new Error(
      "Could not read Chrome Cookies database. " +
        "Make sure Chrome is installed and the Cookies file exists.",
    );
  } finally {
    // Clean up temp files
    try {
      unlinkSync(tmpCookiesDb);
    } catch {}
    try {
      unlinkSync(tmpCookiesDb + "-wal");
    } catch {}
    try {
      unlinkSync(tmpCookiesDb + "-shm");
    } catch {}
  }

  if (!rawOutput) {
    throw new Error(
      "No Amazon cookies found in Chrome. " +
        "Make sure you are signed into Amazon in Chrome.",
    );
  }

  // 4. Decrypt each cookie
  const cookies: ExtractedCredential[] = [];
  for (const line of rawOutput.split("\n")) {
    const parts = line.split("|");
    if (parts.length < 7) continue;
    const [name, encHex, domain, path, httpOnly, secure, expiresUtc] = parts;
    if (!encHex) continue;

    const value = decryptChromeCookie(encHex, derivedKey);
    if (!value) continue;

    cookies.push({
      name,
      value,
      domain,
      path: path || "/",
      httpOnly: httpOnly === "1",
      secure: secure === "1",
      expires:
        expiresUtc && expiresUtc !== "0"
          ? Math.floor(parseInt(expiresUtc, 10) / 1000000 - 11644473600)
          : undefined,
    });
  }

  // 5. Validate required cookies are present
  const cookieNames = new Set(cookies.map((c) => c.name));
  if (!cookieNames.has("session-id")) {
    throw new Error(
      "Chrome cookies are missing required Amazon cookie: session-id. " +
        "Make sure you are signed into Amazon in Chrome.",
    );
  }
  if (!cookieNames.has("ubid-main")) {
    throw new Error(
      "Chrome cookies are missing required Amazon cookie: ubid-main. " +
        "Make sure you are signed into Amazon in Chrome.",
    );
  }
  if (!cookieNames.has("at-main") && !cookieNames.has("x-main")) {
    throw new Error(
      "Chrome cookies are missing required Amazon auth cookie (at-main or x-main). " +
        "Make sure you are fully signed into Amazon in Chrome.",
    );
  }

  return {
    cookies,
  };
}
