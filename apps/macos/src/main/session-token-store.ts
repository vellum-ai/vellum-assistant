import { app, safeStorage } from "electron";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import log from "./logger";

const TOKEN_FILENAME = "session.enc";

// In-memory fallback for when safeStorage is unavailable (unsigned
// local builds). Populated by saveSessionToken, cleared by
// clearSessionToken. The renderer reads it via the synchronous
// vellum:auth:getSessionToken IPC handler, so the token never leaves
// the main process.
let inMemoryToken: string | null = null;

function tokenFilePath(): string {
  return path.join(app.getPath("userData"), TOKEN_FILENAME);
}

/** The persisted token, or `null` when signed out or unreadable. */
export function getSessionToken(): string | null {
  try {
    const encrypted = readFileSync(tokenFilePath());
    if (!safeStorage.isEncryptionAvailable()) return inMemoryToken;
    return safeStorage.decryptString(encrypted) || null;
  } catch (err) {
    // Missing or corrupt file — fall back to in-memory token.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      log.warn("[session-token] failed to read persisted token:", err);
    }
    return inMemoryToken;
  }
}

/** Persist the token encrypted at rest. No-op (warns) when the OS keychain is unavailable. */
export function saveSessionToken(token: string): void {
  inMemoryToken = token;
  if (!safeStorage.isEncryptionAvailable()) {
    log.warn("[session-token] OS encryption unavailable; token not persisted");
    return;
  }
  writeFileSync(tokenFilePath(), safeStorage.encryptString(token), {
    mode: 0o600,
  });
}

/** Delete the persisted token. */
export function clearSessionToken(): void {
  inMemoryToken = null;
  try {
    unlinkSync(tokenFilePath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      log.warn("[session-token] failed to delete persisted token:", err);
    }
  }
}

export function __resetForTesting(): void {
  inMemoryToken = null;
}
