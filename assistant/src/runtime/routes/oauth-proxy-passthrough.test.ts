import { describe, expect, test } from "bun:test";

import {
  CredentialRequiredError,
  InsufficientBalanceError,
  ProviderUnreachableError,
} from "../../oauth/platform-connection.js";
import { BackendError } from "../../util/errors.js";
import { BadRequestError, ForbiddenError, RouteError } from "./errors.js";
import {
  ambiguousConnectionError,
  encodeProxyProviderSegment,
  extractProxyRemainder,
  mapProxyRequestError,
  mapProxyResolveError,
  materializeProxyResponse,
  normalizeProxyPath,
  parseProxyProviderSegment,
  parseProxyQuery,
  PROXY_LOCATION_HEADER,
  PROXY_PATH_PREFIX,
  PROXY_ROUTE_ENDPOINT,
  proxyGrantSubject,
  sanitizeInboundHeaders,
} from "./oauth-proxy-passthrough.js";

const proxyUrl = (path: string): URL =>
  new URL(`http://127.0.0.1:7821${PROXY_PATH_PREFIX}${path}`);

const bodyText = async (body: BodyInit | null): Promise<string> =>
  await new Response(body).text();

describe("route constants", () => {
  test("the prefix is the v1 mount of the route pattern", () => {
    // Route endpoints are registered without the `/v1/` the server mounts
    // them under, and the prefix is that same pattern up to the provider.
    const [beforeProvider] = PROXY_ROUTE_ENDPOINT.split(":provider");
    expect(PROXY_PATH_PREFIX).toBe(`/v1/${beforeProvider}`);
  });

  test("the remainder starts after the prefix and the provider segment", () => {
    const url = proxyUrl("stripe_link/v1/items");

    expect(url.pathname).toBe(`${PROXY_PATH_PREFIX}stripe_link/v1/items`);
    expect(extractProxyRemainder(url)).toBe("v1/items");
  });
});

describe("provider segment", () => {
  test("round-trips a provider with an email account", () => {
    const segment = encodeProxyProviderSegment("stripe_link", "a@example.com");
    expect(segment).toBe("stripe_link@a%40example.com");
    // The router percent-decodes before the handler sees the segment.
    expect(parseProxyProviderSegment(decodeURIComponent(segment))).toEqual({
      provider: "stripe_link",
      account: "a@example.com",
    });
  });

  test("omits the account when there is none", () => {
    expect(encodeProxyProviderSegment("stripe_link")).toBe("stripe_link");
    expect(parseProxyProviderSegment("stripe_link")).toEqual({
      provider: "stripe_link",
    });
  });

  test("splits at the first @ so accounts keep theirs", () => {
    expect(parseProxyProviderSegment("google@a@b.example.com")).toEqual({
      provider: "google",
      // generic-examples:ignore-next-line — reason: tests multi-@ parsing; a@b.example.com is the account segment after the first @
      account: "a@b.example.com",
    });
  });

  test("an empty trailing account is treated as absent", () => {
    expect(parseProxyProviderSegment("stripe_link@")).toEqual({
      provider: "stripe_link",
    });
  });

  test("rejects an empty provider or one carrying a slash", () => {
    expect(() => parseProxyProviderSegment("")).toThrow(BadRequestError);
    expect(() => parseProxyProviderSegment("@a@example.com")).toThrow(
      BadRequestError,
    );
    expect(() => parseProxyProviderSegment("a/b")).toThrow(BadRequestError);
  });

  test("refuses to encode a provider key that would parse back wrong", () => {
    // "vendor@region" would encode unchanged and parse back as provider
    // "vendor" pinned to account "region".
    expect(() => encodeProxyProviderSegment("vendor@region")).toThrow(
      BadRequestError,
    );
    expect(() =>
      encodeProxyProviderSegment("vendor@region", "a@example.com"),
    ).toThrow(BadRequestError);
    expect(() => encodeProxyProviderSegment("vendor/region")).toThrow(
      BadRequestError,
    );
    expect(() => encodeProxyProviderSegment("")).toThrow(BadRequestError);
  });

  test("refuses a provider key that the subject cannot hold", () => {
    // "vendor:region" mints a four-component local subject, which every
    // subject parser rejects, so the grant could never be used.
    expect(() => encodeProxyProviderSegment("vendor:region")).toThrow(
      BadRequestError,
    );
    expect(() =>
      encodeProxyProviderSegment("vendor:region", "a@example.com"),
    ).toThrow(BadRequestError);
    expect(() => parseProxyProviderSegment("vendor:region")).toThrow(
      BadRequestError,
    );
    expect(() =>
      parseProxyProviderSegment("vendor:region@a@example.com"),
    ).toThrow(BadRequestError);
  });

  test.each([
    ".",
    "..",
    "vendor#fragment",
    "vendor?query",
    "vendor%2Fregion",
    "vendor\\region",
    "vendor region",
    "vendor\tregion",
    "vendor\rregion",
    "vendor\n",
    "vendor\u0000region",
    "vendor\u007fregion",
    "vendor\u0085region",
    "vendor\u00a0region",
    "vendor\u00e9",
    "vendor\uD800",
  ])("rejects URL-unstable provider key %j on mint and parse", (provider) => {
    for (const account of [undefined, "a@example.com"]) {
      expect(() => encodeProxyProviderSegment(provider, account)).toThrow(
        BadRequestError,
      );
      expect(() => proxyGrantSubject(provider, account)).toThrow(
        BadRequestError,
      );
      const segment = account ? `${provider}@${account}` : provider;
      expect(() => parseProxyProviderSegment(segment)).toThrow(BadRequestError);
    }
  });

  test.each(["Vendor.region-1_~", ".vendor", "vendor..", "..."])(
    "preserves safe custom provider key %s in URLs and subjects",
    (provider) => {
      const segment = encodeProxyProviderSegment(provider);
      const url = proxyUrl(`${segment}/v1/items`);

      expect(segment).toBe(provider);
      expect(url.pathname).toBe(`${PROXY_PATH_PREFIX}${provider}/v1/items`);
      expect(parseProxyProviderSegment(decodeURIComponent(segment))).toEqual({
        provider,
      });
      expect(proxyGrantSubject(provider)).toBe(
        `local:self:oauth-proxy.${provider}`,
      );
    },
  );

  test("percent-encoding keeps a subject-hostile account safe", () => {
    // A colon or a newline in an account never reaches the subject or the
    // header verbatim, so the account needs no rejection of its own.
    expect(encodeProxyProviderSegment("stripe_link", "a:b")).toBe(
      "stripe_link@a%3Ab",
    );
    expect(encodeProxyProviderSegment("stripe_link", "a\nb")).toBe(
      "stripe_link@a%0Ab",
    );
    expect(
      parseProxyProviderSegment(decodeURIComponent("stripe_link@a%3Ab")),
    ).toEqual({ provider: "stripe_link", account: "a:b" });
  });

  test("an empty account pins nothing and stays well formed", () => {
    const segment = encodeProxyProviderSegment("stripe_link", "");

    expect(segment).toBe("stripe_link");
    expect(parseProxyProviderSegment(segment)).toEqual({
      provider: "stripe_link",
    });
    expect(proxyGrantSubject("stripe_link", "")).toBe(
      "local:self:oauth-proxy.stripe_link",
    );
  });

  test("refuses an account that cannot be percent-encoded", () => {
    // A lone surrogate makes `encodeURIComponent` throw; the caller gets a 400
    // rather than an unhandled URIError.
    expect(() => encodeProxyProviderSegment("stripe_link", "\uD800")).toThrow(
      BadRequestError,
    );
  });
});

describe("proxyGrantSubject", () => {
  test("names the provider the grant is bound to", () => {
    expect(proxyGrantSubject("stripe_link")).toBe(
      "local:self:oauth-proxy.stripe_link",
    );
  });

  test("a pinned account gets its own subject, matching the URL segment", () => {
    const subject = proxyGrantSubject("stripe_link", "a@example.com");

    expect(subject).toBe("local:self:oauth-proxy.stripe_link@a%40example.com");
    expect(subject).toBe(
      `local:self:oauth-proxy.${encodeProxyProviderSegment(
        "stripe_link",
        "a@example.com",
      )}`,
    );
    expect(subject).not.toBe(proxyGrantSubject("stripe_link"));
    expect(subject).not.toBe(proxyGrantSubject("stripe_link", "b@example.com"));
  });

  test("stays a three-component local subject whatever the account holds", () => {
    for (const account of ["a@example.com", "a:b", "a b", "a/b", "a%3Ab"]) {
      expect(proxyGrantSubject("stripe_link", account).split(":")).toHaveLength(
        3,
      );
    }
  });
});

describe("extractProxyRemainder", () => {
  test("preserves percent-encoding and a trailing slash", () => {
    expect(
      extractProxyRemainder(proxyUrl("stripe_link/v1/a%2Fb/items/?x=1")),
    ).toBe("v1/a%2Fb/items/");
  });

  test("returns the remainder for a single-segment path", () => {
    expect(extractProxyRemainder(proxyUrl("stripe_link/v1"))).toBe("v1");
  });

  test("is null when the provider segment is the whole path", () => {
    expect(extractProxyRemainder(proxyUrl("stripe_link"))).toBeNull();
    expect(extractProxyRemainder(proxyUrl("stripe_link/"))).toBeNull();
  });
});

describe("normalizeProxyPath", () => {
  test("prefixes a slash and keeps segments verbatim", () => {
    expect(normalizeProxyPath("v1/a%2Fb/items")).toBe("/v1/a%2Fb/items");
  });

  test("keeps a trailing slash", () => {
    expect(normalizeProxyPath("v1/items/")).toBe("/v1/items/");
  });

  test("resolves . and .. inside the path", () => {
    expect(normalizeProxyPath("v1/items/../charges")).toBe("/v1/charges");
    expect(normalizeProxyPath("v1/./items")).toBe("/v1/items");
  });

  test("a .. that consumes the path leaves the root", () => {
    expect(normalizeProxyPath("v1/..")).toBe("/");
    expect(normalizeProxyPath("v1/../")).toBe("/");
  });

  test("rejects a .. that climbs above the root", () => {
    expect(() => normalizeProxyPath("../secrets")).toThrow(BadRequestError);
    expect(() => normalizeProxyPath("v1/../../secrets")).toThrow(
      BadRequestError,
    );
  });

  test("rejects a protocol-relative or absolute URL", () => {
    expect(() => normalizeProxyPath("//evil.example")).toThrow(BadRequestError);
    expect(() => normalizeProxyPath("/evil.example")).toThrow(BadRequestError);
    expect(() => normalizeProxyPath("https://evil.example/x")).toThrow(
      BadRequestError,
    );
  });

  test("rejects an empty interior segment", () => {
    expect(() => normalizeProxyPath("a//b")).toThrow(BadRequestError);
    expect(() => normalizeProxyPath("a//")).toThrow(BadRequestError);
  });
});

describe("parseProxyQuery", () => {
  test("collapses repeated keys into arrays in wire order", () => {
    expect(parseProxyQuery("?x=1&q=a%20b&x=2")).toEqual({
      x: ["1", "2"],
      q: "a b",
    });
  });

  test("a third repeat extends the array", () => {
    expect(parseProxyQuery("?x=1&x=2&x=3")).toEqual({ x: ["1", "2", "3"] });
  });

  test("is undefined when there is no query", () => {
    expect(parseProxyQuery("")).toBeUndefined();
    expect(parseProxyQuery("?")).toBeUndefined();
  });

  test("a key naming an Object.prototype member is an ordinary key", () => {
    const query = parseProxyQuery(
      "?__proto__=polluted&constructor=c&toString=t",
    );

    expect(Object.entries(query ?? {})).toEqual([
      ["__proto__", "polluted"],
      ["constructor", "c"],
      ["toString", "t"],
    ]);
    // A `__proto__` key is data only because the record inherits nothing.
    expect(Object.getPrototypeOf(query!)).toBeNull();
  });

  test("a repeated __proto__ collapses into an array like any other key", () => {
    expect(
      Object.entries(parseProxyQuery("?__proto__=a&__proto__=b") ?? {}),
    ).toEqual([["__proto__", ["a", "b"]]]);
  });
});

describe("sanitizeInboundHeaders", () => {
  test("strips every hop-by-hop, credential, and edge header", () => {
    const stripped = [
      "Authorization",
      "proxy-authorization",
      "proxy-authenticate",
      "Proxy-Connection",
      "Host",
      "content-length",
      "keep-alive",
      "transfer-encoding",
      "te",
      "trailer",
      "upgrade",
      "expect",
      "accept-encoding",
      "cookie",
      "forwarded",
      "x-real-ip",
      "x-trace-id",
      "x-forwarded-for",
      "x-forwarded-proto",
      "x-vellum-subject",
      "x-vellum-principal-type",
    ];
    const headers = Object.fromEntries(
      stripped.map((name) => [name, "dropped"]),
    );

    expect(sanitizeInboundHeaders(headers)).toEqual({});
  });

  test("strips the connection header and everything it names", () => {
    expect(
      sanitizeInboundHeaders({
        Connection: "keep-alive, X-Custom-Hop",
        "x-custom-hop": "dropped",
        "x-request-id": "req-1",
      }),
    ).toEqual({ "x-request-id": "req-1" });
  });

  test("passes content, negotiation, and custom headers through", () => {
    const headers = {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "link-cli/1.2.3",
      "x-request-id": "req-1",
      "Stripe-Version": "2024-06-20",
    };

    expect(sanitizeInboundHeaders(headers)).toEqual(headers);
  });
});

describe("materializeProxyResponse", () => {
  const upstream = (
    overrides: Partial<{
      status: number;
      headers: Record<string, string>;
      body: unknown;
    }> = {},
  ) => ({
    status: overrides.status ?? 200,
    headers: overrides.headers ?? {},
    body: "body" in overrides ? overrides.body : null,
  });

  test("drops framing headers and keeps the rest", () => {
    const response = materializeProxyResponse(
      upstream({
        status: 201,
        headers: {
          "content-type": "application/json",
          "x-rate-limit-remaining": "9",
          "Content-Length": "999",
          "content-encoding": "gzip",
          "transfer-encoding": "chunked",
          connection: "keep-alive",
          "keep-alive": "timeout=5",
          trailer: "Expires",
          upgrade: "h2c",
        },
        body: { id: "pm_1" },
      }),
      "POST",
    );

    expect(response.status).toBe(201);
    expect(response.headers).toEqual({
      "content-type": "application/json",
      "x-rate-limit-remaining": "9",
    });
  });

  test("strips a provider cookie whatever its casing", () => {
    const response = materializeProxyResponse(
      upstream({
        headers: {
          "Set-Cookie": "sid=abc; Path=/; HttpOnly",
          "set-cookie2": "sid2=def",
          "CONTENT-TYPE": "text/plain",
        },
        body: "ok",
      }),
      "GET",
    );

    expect(response.headers).toEqual({ "CONTENT-TYPE": "text/plain" });
  });

  test.each([300, 301, 302, 303, 304, 305, 307, 308, 399])(
    "%i keeps its status and moves its target off `location`",
    (status) => {
      const response = materializeProxyResponse(
        upstream({
          status,
          headers: {
            Location: "https://files.example.com/blob/abc",
            "content-type": "text/plain",
          },
          body: "moved",
        }),
        "POST",
      );

      expect(response.status).toBe(status);
      expect(response.headers).toEqual({
        "content-type": "text/plain",
        [PROXY_LOCATION_HEADER]: "https://files.example.com/blob/abc",
      });
    },
  );

  test.each([200, 201, 202, 204, 400, 409, 500])(
    "%i preserves Location without exposing the redirect header",
    (status) => {
      const response = materializeProxyResponse(
        upstream({
          status,
          headers: {
            Location: "https://api.example.com/resources/created",
            "x-vellum-proxy-location": "https://evil.example.com/steal",
          },
        }),
        "POST",
      );

      expect(response.status).toBe(status);
      expect(response.headers).toEqual({
        Location: "https://api.example.com/resources/created",
      });
    },
  );

  test("a provider cannot author the daemon's own header namespace", () => {
    const response = materializeProxyResponse(
      upstream({
        status: 302,
        headers: {
          "X-Vellum-Proxy-Location": "https://evil.example.com/steal",
          "x-vellum-subject": "local:self:oauth-proxy.stripe_link",
          location: "https://files.example.com/blob/abc",
        },
      }),
      "GET",
    );

    expect(response.headers).toEqual({
      [PROXY_LOCATION_HEADER]: "https://files.example.com/blob/abc",
    });
  });

  test("serializes an object body and defaults its content type", async () => {
    const response = materializeProxyResponse(
      upstream({ body: { id: "pm_1" } }),
      "GET",
    );

    expect(response.headers["content-type"]).toBe("application/json");
    expect(await bodyText(response.body)).toBe(JSON.stringify({ id: "pm_1" }));
  });

  test("keeps an upstream content type, whatever its casing, over the JSON default", () => {
    const response = materializeProxyResponse(
      upstream({
        headers: { "CoNtEnT-TyPe": "application/vnd.api+json" },
        body: { id: "pm_1" },
      }),
      "GET",
    );

    expect(response.headers).toEqual({
      "CoNtEnT-TyPe": "application/vnd.api+json",
    });
  });

  test("encodes a string body as UTF-8 without touching the content type", async () => {
    const response = materializeProxyResponse(
      upstream({ headers: { "content-type": "text/plain" }, body: "héllo" }),
      "GET",
    );

    expect(response.headers).toEqual({ "content-type": "text/plain" });
    expect(await bodyText(response.body)).toBe("héllo");
  });

  test("passes a Uint8Array body through byte for byte", async () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const response = materializeProxyResponse(upstream({ body: bytes }), "GET");

    expect(
      new Uint8Array(await new Response(response.body).arrayBuffer()),
    ).toEqual(bytes);
  });

  test("a null or undefined body becomes no body", () => {
    expect(materializeProxyResponse(upstream({ body: null }), "GET").body).toBe(
      null,
    );
    expect(
      materializeProxyResponse(upstream({ body: undefined }), "GET").body,
    ).toBe(null);
  });

  test("a 205 carrying the BYO empty-byte body still has no body", () => {
    // `new Response(new Uint8Array(0), { status: 205 })` is a TypeError under
    // a spec-strict Response, and a 205 may not carry content on the wire.
    const response = materializeProxyResponse(
      upstream({ status: 205, body: new Uint8Array(0) }),
      "POST",
    );

    expect(response.body).toBeNull();
    expect(response.status).toBe(205);
  });

  test("HEAD and every null-body status keep their headers and no body", () => {
    const headers = { "content-type": "application/json", etag: 'W/"1"' };

    for (const [status, method] of [
      [200, "HEAD"],
      [204, "DELETE"],
      [205, "POST"],
      [304, "GET"],
    ] as const) {
      const response = materializeProxyResponse(
        upstream({ status, headers, body: { id: "pm_1" } }),
        method,
      );
      expect(response.body).toBeNull();
      expect(response.status).toBe(status);
      expect(response.headers).toEqual(headers);
    }
  });

  const entityMetadataUpstream = () =>
    upstream({
      headers: {
        "Content-Length": "4096",
        "content-encoding": "gzip",
        "transfer-encoding": "chunked",
        connection: "keep-alive",
        "set-cookie": "sid=abc",
        etag: 'W/"1"',
      },
    });

  test("a HEAD keeps the entity metadata it exists to convey", () => {
    const response = materializeProxyResponse(entityMetadataUpstream(), "HEAD");

    expect(response.body).toBeNull();
    expect(response.headers).toEqual({
      "Content-Length": "4096",
      "content-encoding": "gzip",
      etag: 'W/"1"',
    });
  });

  test("a null-body status drops the entity metadata", () => {
    // Bun writes its own `Content-Length: 0` over any value on these, so a
    // forwarded one would sit in the RouteResponse and never reach the wire.
    for (const [status, method] of [
      [204, "DELETE"],
      [205, "POST"],
      [304, "GET"],
    ] as const) {
      const response = materializeProxyResponse(
        { ...entityMetadataUpstream(), status },
        method,
      );

      expect(response.body).toBeNull();
      expect(response.status).toBe(status);
      expect(response.headers).toEqual({ etag: 'W/"1"' });
    }
  });

  test("the length a null-body status declares is the one the wire carries", async () => {
    // Served through Bun, as the HTTP adapter serves it: Bun writes its own
    // `Content-Length: 0` on a null-body status, so anything the object
    // declares and the wire does not is a number no caller can ever read.
    const response = materializeProxyResponse(
      { ...entityMetadataUpstream(), status: 204 },
      "DELETE",
    );
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(response.body, {
          status: response.status,
          headers: response.headers,
        }),
    });
    try {
      const wire = await fetch(server.url);
      const declared = Object.entries(response.headers).find(
        ([name]) => name.toLowerCase() === "content-length",
      )?.[1];

      expect(wire.status).toBe(204);
      expect(wire.headers.get("content-length")).toBe(declared ?? "0");
    } finally {
      server.stop(true);
    }
  });

  test("a body-carrying response drops the entity metadata it re-frames", () => {
    const response = materializeProxyResponse(
      upstream({
        headers: { "content-length": "4096", "content-encoding": "gzip" },
        body: "ok",
      }),
      "GET",
    );

    expect(response.headers).toEqual({});
  });
});

describe("mapProxyResolveError", () => {
  // What the resolver throws when an account filter matches nothing and the
  // provider has other active connections.
  const enumeratingResolverError = new Error(
    'No active OAuth connection found for provider "stripe_link" with account ' +
      '"gone@example.com". Active stripe_link connections: a@example.com, ' +
      "b@example.com. Check the account spelling.",
  );

  test("wraps a plain resolver error as a failed dependency", () => {
    const mapped = mapProxyResolveError(
      new Error("No active connection for stripe_link"),
      "stripe_link",
      "operator",
    );

    expect(mapped.statusCode).toBe(424);
    expect(mapped.code).toBe("FAILED_DEPENDENCY");
    expect(mapped.message).toBe("No active connection for stripe_link");
    expect(mapped.details).toEqual({
      provider: "stripe_link",
      reconnect: "assistant oauth connect stripe_link",
    });
  });

  test("stringifies a non-Error throw for the operator", () => {
    expect(
      mapProxyResolveError("missing scopes", "stripe_link", "operator").message,
    ).toBe("missing scopes");
  });

  test("the grant holder is told nothing about the user's other accounts", () => {
    const mapped = mapProxyResolveError(
      enumeratingResolverError,
      "stripe_link",
    );

    expect(mapped.statusCode).toBe(424);
    expect(mapped.message).toBe(
      "No usable stripe_link connection is available.",
    );
    expect(mapped.message).not.toContain("@example.com");
    expect(mapped.details).toEqual({
      provider: "stripe_link",
      reconnect: "assistant oauth connect stripe_link",
    });
  });

  test("redacting is the default, so a new call site cannot leak by omission", () => {
    expect(
      mapProxyResolveError(enumeratingResolverError, "stripe_link"),
    ).toEqual(
      mapProxyResolveError(
        enumeratingResolverError,
        "stripe_link",
        "grant-holder",
      ),
    );
  });

  test("the operator, whose accounts these are, sees them named", () => {
    const mapped = mapProxyResolveError(
      enumeratingResolverError,
      "stripe_link",
      "operator",
    );

    expect(mapped.message).toBe(enumeratingResolverError.message);
    expect(mapped.message).toContain("a@example.com");
  });

  test("returns a RouteError unchanged", () => {
    const original = new ForbiddenError("nope");
    expect(mapProxyResolveError(original, "stripe_link")).toBe(original);
    expect(mapProxyResolveError(original, "stripe_link", "operator")).toBe(
      original,
    );
  });
});

describe("mapProxyRequestError", () => {
  const RECONNECT = {
    provider: "stripe_link",
    reconnect: "assistant oauth connect stripe_link",
  };

  // Stands in for `TokenExpiredError` from security/token-manager.js, which
  // this pure module deliberately does not import.
  const tokenExpiredError = (message: string): Error => {
    const err = new Error(message);
    err.name = "TokenExpiredError";
    return err;
  };

  /** An upstream failure the connection layer surfaced with a status. */
  const withStatus = (status: number): Error => {
    const err = new Error(`HTTP ${status} from stripe_link`);
    (err as Error & { status: number }).status = status;
    return err;
  };

  const credentialFailures = (): Error[] => [
    new CredentialRequiredError("Token revoked"),
    tokenExpiredError(
      'Token refresh failed for "stripe_link": {"error":"invalid_grant"}.',
    ),
    tokenExpiredError(
      'Token refresh for "stripe_link" is temporarily suspended after 3 ' +
        "consecutive failures. Retrying in 42s.",
    ),
    withStatus(401),
  ];

  const upstreamFailures = (): Error[] => [
    new ProviderUnreachableError(
      "The external service provider is temporarily unreachable (HTTP 502). " +
        "Detail: upstream said no",
    ),
    new BackendError("Platform proxy returned unexpected status 500"),
    new TypeError("fetch failed"),
    withStatus(403),
  ];

  test("a dead credential asks the grant holder to reconnect and names no upstream text", () => {
    // The provider token endpoint's own response and the refresh breaker's
    // state ride on these messages.
    for (const err of credentialFailures()) {
      const mapped = mapProxyRequestError(err, "stripe_link");

      expect(mapped.statusCode).toBe(424);
      expect(mapped.message).toBe(
        "The stripe_link credential is no longer usable.",
      );
      expect(mapped.details).toEqual(RECONNECT);
    }
  });

  test("the operator reads the same failures verbatim", () => {
    for (const err of credentialFailures()) {
      const mapped = mapProxyRequestError(err, "stripe_link", "operator");

      expect(mapped.statusCode).toBe(424);
      expect(mapped.message).toBe(err.message);
      expect(mapped.details).toEqual(RECONNECT);
    }
  });

  test("an upstream failure reaches the grant holder as an unreachable API", () => {
    for (const err of upstreamFailures()) {
      expect(mapProxyRequestError(err, "stripe_link")).toMatchObject({
        statusCode: 502,
        code: "BAD_GATEWAY",
        message: "The stripe_link API could not be reached.",
      });
    }
  });

  test("the operator reads the upstream body verbatim", () => {
    for (const err of upstreamFailures()) {
      const mapped = mapProxyRequestError(err, "stripe_link", "operator");

      expect(mapped.statusCode).toBe(502);
      expect(mapped.message).toBe(err.message);
    }
  });

  test("an insufficient balance reads the same to both audiences", () => {
    // Raised on a bare platform status with a fixed message about this
    // install's own balance, so there is nothing upstream to withhold.
    for (const audience of ["grant-holder", "operator"] as const) {
      const mapped = mapProxyRequestError(
        new InsufficientBalanceError(),
        "stripe_link",
        audience,
      );

      expect(mapped.statusCode).toBe(402);
      expect(mapped.code).toBe("PAYMENT_REQUIRED");
      expect(mapped.message).toBe(new InsufficientBalanceError().message);
    }
  });

  test("returns a RouteError unchanged for either audience", () => {
    const original = new RouteError("teapot", "TEAPOT", 418);
    expect(mapProxyRequestError(original, "stripe_link")).toBe(original);
    expect(mapProxyRequestError(original, "stripe_link", "operator")).toBe(
      original,
    );
  });

  test("the grant holder is the default audience", () => {
    const err = new CredentialRequiredError("Token revoked");
    expect(mapProxyRequestError(err, "stripe_link").message).toBe(
      mapProxyRequestError(err, "stripe_link", "grant-holder").message,
    );
  });
});

describe("ambiguousConnectionError", () => {
  const ACCOUNTS = ["a@example.com", "b@example.com"];

  test("names both accounts and how to pin one for the operator", () => {
    const err = ambiguousConnectionError("stripe_link", ACCOUNTS, "operator");

    expect(err.statusCode).toBe(409);
    expect(err.message).toContain("a@example.com");
    expect(err.message).toContain("b@example.com");
    expect(err.message).toContain("stripe_link@a%40example.com");
    expect(err.details).toEqual({
      provider: "stripe_link",
      accounts: ["a@example.com", "b@example.com"],
      providerSegments: [
        "stripe_link@a%40example.com",
        "stripe_link@b%40example.com",
      ],
    });
  });

  test("names every account even when a label pins no segment", () => {
    // Account labels are nullable free text: one may be empty, and one may
    // hold a lone surrogate that `encodeURIComponent` refuses.
    const accounts = ["", "\uD800", "b@example.com"];

    const err = ambiguousConnectionError("stripe_link", accounts, "operator");

    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("CONFLICT");
    // The empty label is in the joined list as an empty run of text, which no
    // assertion can distinguish from its absence; the rest are checked.
    for (const account of accounts.filter(Boolean)) {
      expect(err.message).toContain(account);
    }
    expect(err.message).toContain('"stripe_link@b%40example.com"');
    expect(err.details).toEqual({
      provider: "stripe_link",
      accounts,
      providerSegments: ["stripe_link@b%40example.com"],
    });
  });

  test("drops the example when no account can pin a segment", () => {
    const err = ambiguousConnectionError(
      "stripe_link",
      ["", "\uD800"],
      "operator",
    );

    expect(err.statusCode).toBe(409);
    expect(err.message).toContain("Multiple stripe_link connections");
    expect(err.message).not.toContain("for example");
    expect(err.details).toEqual({
      provider: "stripe_link",
      accounts: ["", "\uD800"],
      providerSegments: [],
    });
  });

  test("the grant holder is named no account and pointed at a new mint", () => {
    // An unpinned grant's subject matches the bare provider segment alone, so
    // rewriting the base URL to name an account would 403 rather than resolve.
    const err = ambiguousConnectionError("stripe_link", ACCOUNTS);

    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("CONFLICT");
    for (const account of ACCOUNTS) {
      expect(err.message).not.toContain(account);
    }
    expect(err.message).not.toContain("stripe_link@");
    expect(err.message).toContain(
      "assistant oauth proxy-url stripe_link --account <account>",
    );
    expect(err.details).toEqual({ provider: "stripe_link" });
  });

  test("redacting is the default, so a new call site cannot leak by omission", () => {
    expect(ambiguousConnectionError("stripe_link", ACCOUNTS)).toEqual(
      ambiguousConnectionError("stripe_link", ACCOUNTS, "grant-holder"),
    );
  });
});
