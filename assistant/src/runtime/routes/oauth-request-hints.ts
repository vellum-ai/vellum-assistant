/**
 * The hint the request doors attach to a provider response, composed from
 * the response and the connection facts alone. The route gathers the facts;
 * nothing here reads a store, a config, or a connection, so a hint's wording
 * is assertable without booting the route.
 *
 * The status hints are an ordered list and the first rule that applies wins.
 * The order is precedence, not coincidence: a provider's own reported failure
 * outranks every status, and an HTML 403 must be judged before the generic
 * 401/403 rule or it is never reached. The missing-scope hint is not a rule
 * in the list; it is prepended to whichever hint applied, or stands alone.
 */

export interface RequestHintFacts {
  /** The provider key the request was made under. */
  provider: string;
  status: number;
  headers: Record<string, string>;
  /**
   * The provider's own one-line account of a refusal inside a 2xx, from its
   * declared ok field; absent when the status is the whole verdict.
   */
  reportedFailure?: string;
  /**
   * The channel whose bot credential served the request. Absent when the
   * request acted as a person through their OAuth integration.
   */
  botChannel?: string;
  /** The provider runs in platform-managed mode. */
  managed: boolean;
  /**
   * The base URL the request resolved against: an absolute URL's own origin,
   * otherwise the provider's configured base. Absent when neither is set.
   */
  resolvedBaseUrl?: string;
  /** Required scopes the resolved connection's stored grant lacks. */
  missingScopes: readonly string[];
}

interface RequestHintRule {
  name: string;
  applies(facts: RequestHintFacts): boolean;
  render(facts: RequestHintFacts): string;
}

/** The status hints in precedence order; the first rule that applies wins. */
export const REQUEST_HINT_RULES: readonly RequestHintRule[] = [
  {
    // The body carries the provider's own error code, so the hint says only
    // why a 2xx is being reported as a failure.
    name: "provider reported failure",
    applies: (facts) => facts.reportedFailure !== undefined,
    render: (facts) =>
      `${facts.reportedFailure} in the response body. The body names the error.`,
  },
  {
    // An API refuses with JSON. A 403 carrying an HTML page is a resource
    // host (a file host, a sign-in page) refusing this identity: the same
    // token is what the API accepts, and the resource is simply not visible
    // to it. Blaming the credential sends the caller off to reconnect one
    // that works.
    name: "resource not visible",
    applies: (facts) => facts.status === 403 && isHtmlResponse(facts.headers),
    render: (facts) => {
      const identity = facts.botChannel
        ? `${facts.botChannel} bot`
        : "connected account";
      const requestHost = hostnameOf(facts.resolvedBaseUrl);
      return (
        `Request returned HTTP 403 with an HTML page${requestHost ? ` from ${requestHost}` : ""}, not an API error. ` +
        `That usually means the ${identity} cannot see this resource: it is not shared with it, or the scope it needs is missing. ` +
        `Check the resource's access before treating the credential as revoked; ` +
        (facts.botChannel
          ? `'assistant channels get ${facts.botChannel}' reports the credential itself.`
          : `'assistant oauth status ${facts.provider}' reports the credential itself.`)
      );
    },
  },
  {
    // The recovery steps follow the credential's kind, not the door the
    // request came through: a channel bot's token was stored by the channel's
    // setup, so the OAuth status and connect commands cannot repair it.
    name: "credential rejected",
    applies: (facts) => facts.status === 401 || facts.status === 403,
    render: (facts) =>
      facts.botChannel
        ? `Request returned HTTP ${facts.status}. The ${facts.botChannel} bot credential was rejected; it may have been revoked or reinstalled with fewer scopes.\n\n` +
          `Run 'assistant channels get ${facts.botChannel}' to re-probe the channel and see what it reports.\n` +
          `To reconnect, run the channel's setup skill again.`
        : facts.managed
          ? `Request returned HTTP ${facts.status}. The OAuth token may be expired or revoked.\n\n` +
            `Run 'assistant oauth status ${facts.provider}' to check connection health.\n` +
            `To reconnect, run 'assistant oauth connect --help'.`
          : `Request returned HTTP ${facts.status}. The OAuth token may be expired or revoked.\n\n` +
            `Run 'assistant oauth status ${facts.provider}' to check connection status.\n` +
            `To reconnect, run 'assistant oauth connect --help'.`,
  },
  {
    // An HTML 404 (rather than a JSON API error) is the signature of a request
    // reaching a valid host but a path that host does not serve, such as a
    // relative path resolved against a base URL that points at the wrong
    // product. Surface the resolved base so the caller can tell where the path
    // landed, and steer them to an absolute URL for non-default services.
    name: "path not served",
    applies: (facts) => facts.status === 404 && isHtmlResponse(facts.headers),
    render: (facts) =>
      `Request returned HTTP ${facts.status} with an HTML body, which usually means ` +
      `the path does not exist on the base URL it resolved against.\n\n` +
      `This request used base URL "${facts.resolvedBaseUrl ?? "(none configured)"}" (relative paths are joined onto it). ` +
      `If you meant a different service on this provider, pass an absolute URL ` +
      `(e.g. https://host/full/path) so the host and full path are set explicitly.`,
  },
];

/**
 * The hint for one provider response, or undefined when nothing applies.
 * A missing-scope hint is prepended to the status hint, or stands alone: a
 * connection made before a scope was required keeps working for every call
 * that does not need it, so the gap is named on every request.
 */
export function composeRequestHint(
  facts: RequestHintFacts,
): string | undefined {
  const hint = REQUEST_HINT_RULES.find((rule) => rule.applies(facts))?.render(
    facts,
  );
  if (facts.missingScopes.length === 0) {
    return hint;
  }
  const scopeHint =
    `The ${facts.provider} connection is missing required scopes: ${facts.missingScopes.join(", ")}. ` +
    `It was connected before they were required, so calls that need them fail. ` +
    `Reconnect it from Integrations, or run 'assistant oauth connect ${facts.provider}', to grant them.`;
  return hint ? `${scopeHint}\n\n${hint}` : scopeHint;
}

/** True when the response's Content-Type header indicates an HTML body. */
function isHtmlResponse(headers: Record<string, string>): boolean {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "content-type") {
      return value.toLowerCase().includes("text/html");
    }
  }
  return false;
}

function hostnameOf(url: string | undefined): string | undefined {
  return url && URL.canParse(url) ? new URL(url).hostname : undefined;
}
