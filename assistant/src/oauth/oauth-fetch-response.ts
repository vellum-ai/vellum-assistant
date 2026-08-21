import type { OAuthConnectionResponse } from "./connection.js";

/** Default per-request timeout so a hung upstream cannot block indefinitely. */
export const OAUTH_REQUEST_TIMEOUT_MS = 30_000;

export async function parseOAuthFetchResponse(
  resp: Response,
): Promise<OAuthConnectionResponse> {
  const headers: Record<string, string> = {};
  resp.headers.forEach((value, key) => {
    headers[key] = value;
  });

  let body: unknown;
  const text = await resp.text().catch(() => "");
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  } else {
    body = null;
  }

  return { status: resp.status, headers, body };
}
