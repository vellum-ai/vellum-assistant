/**
 * Caller-side OAuth request plan.
 *
 * The daemon resolves the connection, enforces the host allowlist, and
 * (for BYO) mints a short-lived access token. The CLI process then
 * performs the HTTP call so Gmail-sized JSON parse and response
 * buffering stay off the daemon event loop.
 */

export type OAuthCallerAuthScheme = "Bearer" | "Bot" | "none";

export interface OAuthDirectCallerPlan {
  mode: "direct";
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  authScheme: OAuthCallerAuthScheme;
  account: string | null;
  accountWarning?: string;
}

export interface OAuthPlatformProxyCallerPlan {
  mode: "platform_proxy";
  proxyPath: string;
  envelope: {
    request: {
      method: string;
      path: string;
      query: Record<string, string | string[]>;
      headers: Record<string, string>;
      body: unknown;
      base_url?: string;
    };
  };
  account: string | null;
  accountWarning?: string;
}

export type OAuthCallerPlan =
  | OAuthDirectCallerPlan
  | OAuthPlatformProxyCallerPlan;

export function isOAuthCallerPlan(value: unknown): value is OAuthCallerPlan {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const mode = (value as { mode?: unknown }).mode;
  return mode === "direct" || mode === "platform_proxy";
}
