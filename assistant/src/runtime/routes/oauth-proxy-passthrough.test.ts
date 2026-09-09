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
  test("the endpoint pattern and the prefix agree", () => {
    expect(PROXY_ROUTE_ENDPOINT).toBe("oauth/proxy/:provider/:path*");
    expect(PROXY_PATH_PREFIX).toBe("/v1/oauth/proxy/");
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
});

describe("proxyGrantSubject", () => {
  test("names the provider the grant is bound to", () => {
    expect(proxyGrantSubject("stripe_link")).toBe(
      "local:self:oauth-proxy.stripe_link",
    );
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
    // The literal-object build would have mutated this prototype instead.
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
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

  test("serializes an object body and defaults its content type", async () => {
    const response = materializeProxyResponse(
      upstream({ body: { id: "pm_1" } }),
      "GET",
    );

    expect(response.headers["content-type"]).toBe("application/json");
    expect(await bodyText(response.body)).toBe(JSON.stringify({ id: "pm_1" }));
  });

  test("keeps an upstream content type over the JSON default", () => {
    const response = materializeProxyResponse(
      upstream({
        headers: { "Content-Type": "application/vnd.api+json" },
        body: { id: "pm_1" },
      }),
      "GET",
    );

    expect(response.headers).toEqual({
      "Content-Type": "application/vnd.api+json",
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

  test("HEAD, 204, and 304 carry no body but keep their headers", () => {
    const headers = { "content-type": "application/json", etag: 'W/"1"' };

    for (const [status, method] of [
      [200, "HEAD"],
      [204, "DELETE"],
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
});

describe("mapProxyResolveError", () => {
  test("wraps a plain resolver error as a failed dependency", () => {
    const mapped = mapProxyResolveError(
      new Error("No active connection for stripe_link"),
      "stripe_link",
    );

    expect(mapped.statusCode).toBe(424);
    expect(mapped.code).toBe("FAILED_DEPENDENCY");
    expect(mapped.message).toBe("No active connection for stripe_link");
    expect(mapped.details).toEqual({
      provider: "stripe_link",
      reconnect: "assistant oauth connect stripe_link",
    });
  });

  test("stringifies a non-Error throw", () => {
    expect(mapProxyResolveError("missing scopes", "stripe_link").message).toBe(
      "missing scopes",
    );
  });

  test("returns a RouteError unchanged", () => {
    const original = new ForbiddenError("nope");
    expect(mapProxyResolveError(original, "stripe_link")).toBe(original);
  });
});

describe("mapProxyRequestError", () => {
  test("an expired credential asks the caller to reconnect", () => {
    const mapped = mapProxyRequestError(
      new CredentialRequiredError("Token revoked"),
      "stripe_link",
    );

    expect(mapped.statusCode).toBe(424);
    expect(mapped.message).toBe("Token revoked");
    expect(mapped.details).toEqual({
      provider: "stripe_link",
      reconnect: "assistant oauth connect stripe_link",
    });
  });

  // Stands in for `TokenExpiredError` from security/token-manager.js, which
  // this pure module deliberately does not import.
  const tokenExpiredError = (message: string): Error => {
    const err = new Error(message);
    err.name = "TokenExpiredError";
    return err;
  };

  test("a BYO token expiry asks the caller to reconnect", () => {
    const mapped = mapProxyRequestError(
      tokenExpiredError(
        'No access token found for "stripe_link". Authorization required.',
      ),
      "stripe_link",
    );

    expect(mapped.statusCode).toBe(424);
    expect(mapped.details).toEqual({
      provider: "stripe_link",
      reconnect: "assistant oauth connect stripe_link",
    });
  });

  test("a BYO 401 that survived a refresh asks the caller to reconnect", () => {
    const err = new Error("HTTP 401 from stripe_link");
    (err as Error & { status: number }).status = 401;

    const mapped = mapProxyRequestError(err, "stripe_link");

    expect(mapped.statusCode).toBe(424);
    expect(mapped.message).toBe("HTTP 401 from stripe_link");
    expect(mapped.details).toEqual({
      provider: "stripe_link",
      reconnect: "assistant oauth connect stripe_link",
    });
  });

  test("another upstream status is still a bad gateway", () => {
    const err = new Error("HTTP 403 from stripe_link");
    (err as Error & { status: number }).status = 403;

    expect(mapProxyRequestError(err, "stripe_link")).toMatchObject({
      statusCode: 502,
      code: "BAD_GATEWAY",
      message: "HTTP 403 from stripe_link",
    });
  });

  test("an insufficient balance is payment required", () => {
    const mapped = mapProxyRequestError(
      new InsufficientBalanceError("Add funds"),
      "stripe_link",
    );

    expect(mapped.statusCode).toBe(402);
    expect(mapped.code).toBe("PAYMENT_REQUIRED");
    expect(mapped.message).toBe("Add funds");
  });

  test("an unreachable provider is a bad gateway", () => {
    const mapped = mapProxyRequestError(
      new ProviderUnreachableError("Upstream 502"),
      "stripe_link",
    );

    expect(mapped.statusCode).toBe(502);
    expect(mapped.code).toBe("BAD_GATEWAY");
    expect(mapped.message).toBe("Upstream 502");
  });

  test("returns a RouteError unchanged", () => {
    const original = new RouteError("teapot", "TEAPOT", 418);
    expect(mapProxyRequestError(original, "stripe_link")).toBe(original);
  });

  test("any other failure is a bad gateway carrying the message", () => {
    expect(
      mapProxyRequestError(
        new BackendError("Platform proxy returned unexpected status 500"),
        "stripe_link",
      ),
    ).toMatchObject({
      statusCode: 502,
      message: "Platform proxy returned unexpected status 500",
    });
    expect(
      mapProxyRequestError(new TypeError("fetch failed"), "stripe_link"),
    ).toMatchObject({ statusCode: 502, message: "fetch failed" });
  });
});

describe("ambiguousConnectionError", () => {
  test("names both accounts and how to pin one", () => {
    const err = ambiguousConnectionError("stripe_link", [
      "a@example.com",
      "b@example.com",
    ]);

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
});
