/**
 * The request doors' hint, asserted on the composer directly. Every case
 * pins the rendered text in full, so a wording change is a visible diff here
 * and never a silent one behind a route test's substring match.
 */

import { describe, expect, test } from "bun:test";

import {
  composeRequestHint,
  REQUEST_HINT_RULES,
  type RequestHintFacts,
} from "./oauth-request-hints.js";

const JSON_HEADERS = { "content-type": "application/json" };
const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };

function asBot(overrides: Partial<RequestHintFacts> = {}): RequestHintFacts {
  return {
    provider: "slack_channel",
    status: 200,
    headers: JSON_HEADERS,
    botChannel: "slack",
    managed: false,
    resolvedBaseUrl: "https://slack.com/api",
    missingScopes: [],
    ...overrides,
  };
}

function asPerson(overrides: Partial<RequestHintFacts> = {}): RequestHintFacts {
  return {
    provider: "google",
    status: 200,
    headers: JSON_HEADERS,
    managed: false,
    resolvedBaseUrl: "https://api.google.com",
    missingScopes: [],
    ...overrides,
  };
}

describe("composeRequestHint", () => {
  test("the rules are applied in this precedence order", () => {
    // The generic 401/403 rule matches every 403, so the HTML 403 rule has
    // to be judged before it; a provider's own reported failure outranks
    // every status. The list is the order, and this pins it.
    expect(REQUEST_HINT_RULES.map((rule) => rule.name)).toEqual([
      "provider reported failure",
      "resource not visible",
      "credential rejected",
      "path not served",
    ]);
  });

  test("a 2xx is silent", () => {
    expect(composeRequestHint(asBot())).toBeUndefined();
    expect(composeRequestHint(asPerson())).toBeUndefined();
  });

  test("a provider's reported failure names only why the 2xx failed", () => {
    expect(
      composeRequestHint(
        asBot({
          reportedFailure:
            "slack_channel answered HTTP 200 but reported ok: false",
        }),
      ),
    ).toBe(
      "slack_channel answered HTTP 200 but reported ok: false in the response body. The body names the error.",
    );
  });

  test("a reported failure outranks every status rule", () => {
    expect(
      composeRequestHint(
        asBot({
          status: 403,
          headers: HTML_HEADERS,
          reportedFailure:
            "slack_channel answered HTTP 403 but reported ok: false",
        }),
      ),
    ).toBe(
      "slack_channel answered HTTP 403 but reported ok: false in the response body. The body names the error.",
    );
  });

  test("an HTML 403 as a bot names the resource's access and the channel's diagnostics", () => {
    expect(
      composeRequestHint(
        asBot({
          status: 403,
          headers: HTML_HEADERS,
          resolvedBaseUrl: "https://files.slack.com",
        }),
      ),
    ).toBe(
      "Request returned HTTP 403 with an HTML page from files.slack.com, not an API error. " +
        "That usually means the slack bot cannot see this resource: it is not shared with it, or the scope it needs is missing. " +
        "Check the resource's access before treating the credential as revoked; " +
        "'assistant channels get slack' reports the credential itself.",
    );
  });

  test("an HTML 403 as a person names the connected account and oauth status", () => {
    expect(
      composeRequestHint(asPerson({ status: 403, headers: HTML_HEADERS })),
    ).toBe(
      "Request returned HTTP 403 with an HTML page from api.google.com, not an API error. " +
        "That usually means the connected account cannot see this resource: it is not shared with it, or the scope it needs is missing. " +
        "Check the resource's access before treating the credential as revoked; " +
        "'assistant oauth status google' reports the credential itself.",
    );
  });

  test("an HTML 403 with no resolved base omits the host", () => {
    expect(
      composeRequestHint(
        asPerson({
          status: 403,
          headers: HTML_HEADERS,
          resolvedBaseUrl: undefined,
        }),
      ),
    ).toBe(
      "Request returned HTTP 403 with an HTML page, not an API error. " +
        "That usually means the connected account cannot see this resource: it is not shared with it, or the scope it needs is missing. " +
        "Check the resource's access before treating the credential as revoked; " +
        "'assistant oauth status google' reports the credential itself.",
    );
  });

  test("a JSON 403 keeps the credential reading on any host", () => {
    // An API's own refusal, on the base host or on a provider's other API
    // hosts alike.
    const onApiHost = composeRequestHint(asBot({ status: 403 }));
    expect(onApiHost).toContain("slack bot credential was rejected");
    expect(onApiHost).not.toContain("cannot see this resource");

    const onOtherApiHost = composeRequestHint(
      asPerson({
        status: 403,
        resolvedBaseUrl: "https://calendar.googleapis.com",
      }),
    );
    expect(onOtherApiHost).toContain(
      "The OAuth token may be expired or revoked",
    );
    expect(onOtherApiHost).not.toContain("cannot see this resource");
  });

  test("a rejected bot credential points at the channel's diagnostics, never the OAuth commands", () => {
    expect(composeRequestHint(asBot({ status: 401 }))).toBe(
      "Request returned HTTP 401. The slack bot credential was rejected; it may have been revoked or reinstalled with fewer scopes.\n\n" +
        "Run 'assistant channels get slack' to re-probe the channel and see what it reports.\n" +
        "To reconnect, run the channel's setup skill again.",
    );
  });

  test("a rejected managed credential points at connection health", () => {
    expect(composeRequestHint(asPerson({ status: 403, managed: true }))).toBe(
      "Request returned HTTP 403. The OAuth token may be expired or revoked.\n\n" +
        "Run 'assistant oauth status google' to check connection health.\n" +
        "To reconnect, run 'assistant oauth connect --help'.",
    );
  });

  test("a rejected your-own credential points at connection status", () => {
    expect(composeRequestHint(asPerson({ status: 401 }))).toBe(
      "Request returned HTTP 401. The OAuth token may be expired or revoked.\n\n" +
        "Run 'assistant oauth status google' to check connection status.\n" +
        "To reconnect, run 'assistant oauth connect --help'.",
    );
  });

  test("an HTML 404 reports the base the path resolved against", () => {
    expect(
      composeRequestHint(asPerson({ status: 404, headers: HTML_HEADERS })),
    ).toBe(
      "Request returned HTTP 404 with an HTML body, which usually means " +
        "the path does not exist on the base URL it resolved against.\n\n" +
        'This request used base URL "https://api.google.com" (relative paths are joined onto it). ' +
        "If you meant a different service on this provider, pass an absolute URL " +
        "(e.g. https://host/full/path) so the host and full path are set explicitly.",
    );
  });

  test("an HTML 404 with no base says so", () => {
    expect(
      composeRequestHint(
        asPerson({
          status: 404,
          headers: HTML_HEADERS,
          resolvedBaseUrl: undefined,
        }),
      ),
    ).toContain('This request used base URL "(none configured)"');
  });

  test("a JSON 404 and every other status are silent", () => {
    expect(composeRequestHint(asPerson({ status: 404 }))).toBeUndefined();
    expect(composeRequestHint(asPerson({ status: 429 }))).toBeUndefined();
    expect(composeRequestHint(asPerson({ status: 500 }))).toBeUndefined();
  });

  test("the Content-Type check is case-insensitive on key and value", () => {
    expect(
      composeRequestHint(
        asPerson({ status: 404, headers: { "Content-Type": "TEXT/HTML" } }),
      ),
    ).toContain("with an HTML body");
  });

  test("a missing-scope hint stands alone on a successful call", () => {
    expect(
      composeRequestHint(
        asPerson({ provider: "slack", missingScopes: ["files:read"] }),
      ),
    ).toBe(
      "The slack connection is missing required scopes: files:read. " +
        "It was connected before they were required, so calls that need them fail. " +
        "Reconnect it from Integrations, or run 'assistant oauth connect slack', to grant them.",
    );
  });

  test("a missing-scope hint is prepended to the status hint", () => {
    expect(
      composeRequestHint(
        asPerson({
          provider: "slack",
          status: 401,
          missingScopes: ["files:read", "search:read"],
        }),
      ),
    ).toBe(
      "The slack connection is missing required scopes: files:read, search:read. " +
        "It was connected before they were required, so calls that need them fail. " +
        "Reconnect it from Integrations, or run 'assistant oauth connect slack', to grant them." +
        "\n\n" +
        "Request returned HTTP 401. The OAuth token may be expired or revoked.\n\n" +
        "Run 'assistant oauth status slack' to check connection status.\n" +
        "To reconnect, run 'assistant oauth connect --help'.",
    );
  });
});
