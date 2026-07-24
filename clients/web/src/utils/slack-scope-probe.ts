import {
  SLACK_MANIFEST_BOT_SCOPES,
  SLACK_MANIFEST_BOT_SCOPES_OPTIONAL,
} from "./slack-manifest";

const AUTH_TEST_URL = "https://slack.com/api/auth.test";

/** Fallback when `auth.test` doesn't tell us which app the token belongs to. */
const SLACK_APPS_URL = "https://api.slack.com/apps";

/**
 * Outcome of the post-install scope check.
 *
 * `degraded` and `incomplete` both mean scopes are missing, but they need
 * opposite responses. A missing optional scope is a choice the workspace made
 * on Slack's consent screen; telling them to reinstall would just replay the
 * same screen and earn the same answer. Only a missing mandatory scope
 * indicates the silent drop that reinstalling actually fixes.
 *
 * `unknown` is a first-class result, not a failure: the browser cannot always
 * read `x-oauth-scopes` off a cross-origin response, and a probe that can't see
 * the granted scopes must stay quiet rather than accuse Slack of dropping them.
 */
export type SlackScopeProbeStatus =
  | "complete"
  | "degraded"
  | "incomplete"
  | "unknown";

export interface SlackScopeProbeResult {
  status: SlackScopeProbeStatus;
  /** Scopes Slack reports on the token, empty when `status` is `unknown`. */
  grantedScopes: string[];
  /** Every expected scope absent from the grant, mandatory or optional. */
  missingScopes: string[];
  /**
   * The mandatory subset of {@link missingScopes}. Non-empty only when
   * `status` is `incomplete`, and the only thing worth a reinstall.
   */
  missingRequiredScopes: string[];
  appId: string | null;
  /** Where to send the user to reinstall and pick up the missing scopes. */
  reinstallUrl: string;
}

/**
 * The slice of `fetch` this probe uses. Narrower than `typeof fetch` so a
 * plain stub satisfies it without restating the platform's overloads.
 */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface ProbeSlackScopesOptions {
  fetchImpl?: FetchLike;
  expectedScopes?: readonly string[];
  /** Subset of `expectedScopes` a workspace may decline without a nudge. */
  optionalScopes?: readonly string[];
}

function reinstallUrlFor(appId: string | null): string {
  return appId ? `${SLACK_APPS_URL}/${appId}/oauth` : SLACK_APPS_URL;
}

function unknown(appId: string | null = null): SlackScopeProbeResult {
  return {
    status: "unknown",
    grantedScopes: [],
    missingScopes: [],
    missingRequiredScopes: [],
    appId,
    reinstallUrl: reinstallUrlFor(appId),
  };
}

/** Slack returns `x-oauth-scopes` as a comma-separated list on every response. */
function parseScopeHeader(raw: string | null): string[] | null {
  if (raw === null) {return null;}
  const scopes = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return scopes.length > 0 ? scopes : null;
}

/**
 * Check what Slack actually granted against what the manifest asked for.
 *
 * Slack's install flow can hand back a token carrying only a fraction of the
 * requested scopes while still reporting a healthy `auth.test` — the install
 * looks clean and the app quietly can't do its job (LUM-2830). Reinstalling
 * from the app's OAuth page fixes the same token, so the payoff for catching
 * this at setup time is a single click.
 *
 * The drop takes mandatory scopes with it, which is what separates it from a
 * workspace deliberately declining an optional one.
 *
 * Never throws: a probe failure resolves to `unknown` so it can't block or
 * falsely fail a setup that otherwise succeeded.
 */
export async function probeSlackScopes(
  botToken: string,
  {
    fetchImpl = fetch,
    expectedScopes = SLACK_MANIFEST_BOT_SCOPES,
    optionalScopes = SLACK_MANIFEST_BOT_SCOPES_OPTIONAL,
  }: ProbeSlackScopesOptions = {},
): Promise<SlackScopeProbeResult> {
  let response: Response;
  try {
    response = await fetchImpl(AUTH_TEST_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${botToken.trim()}` },
    });
  } catch {
    // Network failure or a CORS preflight rejection.
    return unknown();
  }

  let body: { ok?: boolean; app_id?: string } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return unknown();
  }

  // `app_id` is not a guaranteed field on `auth.test`. When it's absent we can
  // still report drift, just without deep-linking to the specific app.
  const appId = typeof body.app_id === "string" ? body.app_id : null;

  // A rejected token is the save path's problem to report, not the probe's.
  if (body.ok !== true) {return unknown(appId);}

  const granted = parseScopeHeader(response.headers.get("x-oauth-scopes"));
  if (granted === null) {return unknown(appId);}

  const grantedSet = new Set(granted);
  const optionalSet = new Set(optionalScopes);
  const missingScopes = expectedScopes.filter((s) => !grantedSet.has(s));
  const missingRequiredScopes = missingScopes.filter((s) => !optionalSet.has(s));

  let status: SlackScopeProbeStatus = "complete";
  if (missingRequiredScopes.length > 0) {
    status = "incomplete";
  } else if (missingScopes.length > 0) {
    status = "degraded";
  }

  return {
    status,
    grantedScopes: granted,
    missingScopes,
    missingRequiredScopes,
    appId,
    reinstallUrl: reinstallUrlFor(appId),
  };
}
