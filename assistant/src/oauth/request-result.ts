import type { OAuthConnectionResponse } from "./connection.js";

export interface OAuthRequestClientResult {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  account: string | null;
  accountWarning?: string;
  hint?: string;
}

export function isHtmlResponse(headers: Record<string, string>): boolean {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "content-type") {
      return value.toLowerCase().includes("text/html");
    }
  }
  return false;
}

export function buildOAuthRequestClientResult(args: {
  response: OAuthConnectionResponse;
  account: string | null;
  accountWarning?: string;
  managed: boolean;
  provider: string;
  resolvedBaseUrl: string;
}): OAuthRequestClientResult {
  const result: OAuthRequestClientResult = {
    ok: args.response.status >= 200 && args.response.status < 300,
    status: args.response.status,
    headers: args.response.headers,
    body: args.response.body,
    account: args.account,
  };

  if (args.accountWarning) {
    result.accountWarning = args.accountWarning;
  }

  const hint = oauthRequestHint({
    status: args.response.status,
    headers: args.response.headers,
    managed: args.managed,
    provider: args.provider,
    resolvedBaseUrl: args.resolvedBaseUrl,
  });
  if (hint) {
    result.hint = hint;
  }

  return result;
}

function oauthRequestHint(args: {
  status: number;
  headers: Record<string, string>;
  managed: boolean;
  provider: string;
  resolvedBaseUrl: string;
}): string | undefined {
  if (args.status === 401 || args.status === 403) {
    return args.managed
      ? `Request returned HTTP ${args.status}. The OAuth token may be expired or revoked.\n\n` +
          `Run 'assistant oauth status ${args.provider}' to check connection health.\n` +
          `To reconnect, run 'assistant oauth connect --help'.`
      : `Request returned HTTP ${args.status}. The OAuth token may be expired or revoked.\n\n` +
          `Run 'assistant oauth status ${args.provider}' to check connection status.\n` +
          `To reconnect, run 'assistant oauth connect --help'.`;
  }

  if (args.status === 404 && isHtmlResponse(args.headers)) {
    return (
      `Request returned HTTP ${args.status} with an HTML body, which usually means ` +
      `the path does not exist on the base URL it resolved against.\n\n` +
      `This request used base URL "${args.resolvedBaseUrl}" (relative paths are joined onto it). ` +
      `If you meant a different service on this provider, pass an absolute URL ` +
      `(e.g. https://host/full/path) so the host and full path are set explicitly.`
    );
  }

  return undefined;
}
