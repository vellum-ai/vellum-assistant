/**
 * Persistence + lifecycle for OpenAI Codex OAuth credentials.
 *
 * Tokens are stored as a single base64-encoded JSON blob in the secure-keys
 * backend (CES → encrypted file fallback) at `credentialKey("openai_codex_oauth", "blob")`.
 * The macOS client writes the same path via `APIKeyManager.setCredential(service:field:)`,
 * which is what `secret-routes.ts` lands at when handling `type: "credential"`
 * POSTs. Single round-trip, atomic update, symmetric across both writers.
 *
 * A single-flight refresh dedupe keeps concurrent requests from triggering
 * parallel refreshes when the access token is near expiry.
 *
 * Distinct from `assistant/src/security/token-manager.ts` (Google/Slack/etc.
 * BYO OAuth integrations), which is connection-scoped and assumes provider
 * config rows in SQLite. This module is provider-singleton: one Codex
 * credential set per assistant, fixed endpoints, no SQLite involvement.
 */

import { credentialKey } from "../../security/credential-key.js";
import {
  deleteSecureKeyAsync,
  getSecureKeyAsync,
  setSecureKeyAsync,
} from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";
import {
  type CodexCredentials,
  refreshOpenAICodexToken,
} from "./codex-oauth.js";

const log = getLogger("openai-codex-credentials");

const SERVICE = "openai_codex_oauth";
const FIELD = "blob";
const STORAGE_KEY = credentialKey(SERVICE, FIELD);

const REFRESH_BUFFER_MS = 60_000;

let inflightRefresh: Promise<CodexCredentials | undefined> | null = null;

function isValidCredentials(value: unknown): value is CodexCredentials {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.access === "string" &&
    v.access.length > 0 &&
    typeof v.refresh === "string" &&
    v.refresh.length > 0 &&
    typeof v.expiresAt === "number" &&
    Number.isFinite(v.expiresAt) &&
    typeof v.accountId === "string" &&
    v.accountId.length > 0
  );
}

async function readStoredCredentials(): Promise<CodexCredentials | undefined> {
  const raw = await getSecureKeyAsync(STORAGE_KEY);
  if (!raw) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64").toString("utf8");
  } catch {
    log.warn(
      "openai_codex_oauth blob is not valid base64 — treating as missing",
    );
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    log.warn("openai_codex_oauth blob is not valid JSON — treating as missing");
    return undefined;
  }
  if (!isValidCredentials(parsed)) {
    log.warn(
      "openai_codex_oauth blob missing required fields — treating as missing",
    );
    return undefined;
  }
  return parsed;
}

export async function setOpenAICodexCredentials(
  creds: CodexCredentials,
): Promise<void> {
  const blob = Buffer.from(JSON.stringify(creds), "utf8").toString("base64");
  await setSecureKeyAsync(STORAGE_KEY, blob);
}

export async function clearOpenAICodexCredentials(): Promise<void> {
  await deleteSecureKeyAsync(STORAGE_KEY);
}

async function performRefresh(
  refreshToken: string,
): Promise<CodexCredentials | undefined> {
  try {
    const refreshed = await refreshOpenAICodexToken(refreshToken);
    await setOpenAICodexCredentials(refreshed);
    log.info(
      { expiresAt: refreshed.expiresAt },
      "Refreshed OpenAI Codex OAuth tokens",
    );
    return refreshed;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "OpenAI Codex token refresh failed",
    );
    return undefined;
  }
}

export async function getOpenAICodexCredentials(opts?: {
  forceRefresh?: boolean;
}): Promise<CodexCredentials | undefined> {
  const stored = await readStoredCredentials();
  if (!stored) return undefined;

  const needsRefresh =
    opts?.forceRefresh === true ||
    stored.expiresAt - Date.now() <= REFRESH_BUFFER_MS;
  if (!needsRefresh) return stored;

  if (!inflightRefresh) {
    inflightRefresh = performRefresh(stored.refresh).finally(() => {
      inflightRefresh = null;
    });
  }
  const refreshed = await inflightRefresh;
  // On a forced refresh (e.g. 401 retry), returning the stale `stored` value
  // would replay the same dead access token and burn the retry budget.
  if (opts?.forceRefresh === true) return refreshed;
  return refreshed ?? stored;
}
