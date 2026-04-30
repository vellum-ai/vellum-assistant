/**
 * OpenAI Codex ("Sign in with ChatGPT") token refresh + JWT helpers.
 *
 * Mints / refreshes OAuth tokens against `auth.openai.com` using the Codex
 * CLI's registered client_id. Tokens authenticate against
 * `https://chatgpt.com/backend-api/codex/responses` and bill against the
 * user's ChatGPT Plus/Pro/Team quota — not their API account.
 *
 * The initial PKCE login flow runs client-side in the macOS app (see
 * `clients/macos/vellum-assistant/Features/Onboarding/CodexOAuth/`). The
 * resulting credential blob is pushed to the daemon via
 * `APIKeyManager.setCredential` and consumed by `codex-credentials.ts`.
 * Only the refresh path (triggered by 401 retry in `OpenAIResponsesProvider`)
 * runs daemon-side, hence this module's surface area.
 */

import { getLogger } from "../../util/logger.js";

const log = getLogger("openai-codex-oauth");

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";

export type CodexCredentials = {
  access: string;
  refresh: string;
  expiresAt: number;
  accountId: string;
};

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function extractAccountId(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.[JWT_AUTH_CLAIM] as
    | { chatgpt_account_id?: unknown }
    | undefined;
  const id = auth?.chatgpt_account_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function finalizeCredentials(json: Record<string, unknown>): CodexCredentials {
  const access = typeof json.access_token === "string" ? json.access_token : "";
  const refresh =
    typeof json.refresh_token === "string" ? json.refresh_token : "";
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 0;
  if (!access || !refresh || expiresIn <= 0) {
    throw new Error("OAuth token response missing required fields");
  }
  const accountId = extractAccountId(access);
  if (!accountId) {
    throw new Error("OAuth access token did not contain chatgpt_account_id");
  }
  return {
    access,
    refresh,
    expiresAt: Date.now() + expiresIn * 1000,
    accountId,
  };
}

export async function refreshOpenAICodexToken(
  refreshToken: string,
): Promise<CodexCredentials> {
  log.debug("Refreshing OpenAI Codex OAuth token");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OAuth refresh failed: HTTP ${res.status} — ${text}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  return finalizeCredentials(json);
}
