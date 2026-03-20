import type { IncomingHttpHeaders } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  buildFetchResponseFromNodeResponse,
  executeWebFetch,
} from "../tools/network/web-fetch.js";

describe("web_fetch tool", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const executeWithMockFetch = (
    input: Record<string, unknown>,
    options?: {
      resolveHostAddresses?: (hostname: string) => Promise<string[]>;
      requestExecutor?: (
        url: URL,
        requestOptions: {
          signal: AbortSignal;
          headers: Record<string, string>;
          resolvedAddress?: string;
        },
      ) => Promise<Response>;
    },
  ) =>
    executeWebFetch(input, {
      ...options,
      requestExecutor:
        options?.requestExecutor ??
        ((url, requestOptions) =>
          globalThis.fetch(url.href, {
            method: "GET",
            redirect: "manual",
            signal: requestOptions.signal,
            headers: requestOptions.headers,
          }) as Promise<Response>),
    });

  test("buildFetchResponseFromNodeResponse handles null-body statuses without throwing", async () => {
    const stream = new PassThrough() as PassThrough & {
      statusCode?: number;
      statusMessage?: string;
      headers: IncomingHttpHeaders;
    };
    stream.statusCode = 204;
    stream.statusMessage = "No Content";
    stream.headers = { "content-type": "text/plain; charset=utf-8" };
    stream.end("ignored body");

    const response = buildFetchResponseFromNodeResponse(stream);
    expect(response.status).toBe(204);
    expect(response.statusText).toBe("No Content");
    expect(await response.text()).toBe("");
  });

  test("rejects missing url", async () => {
    const result = await executeWithMockFetch({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("url is required");
  });

  test("rejects non-http schemes", async () => {
    const result = await executeWithMockFetch({
      url: "ftp://example.com/file.txt",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("url must use http or https");
  });

  test("rejects path-only urls", async () => {
    const result = await executeWithMockFetch({ url: "/docs/getting-started" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("url is required");
  });

  test("adds https:// for bare hostnames", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (url: string) => {
      requestedUrl = url;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({ url: "example.com/docs" });
    expect(result.isError).toBe(false);
    expect(requestedUrl).toBe("https://example.com/docs");
  });

  test("adds https:// for scheme-less host:port inputs", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (url: string) => {
      requestedUrl = url;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({ url: "example.com:8443/docs" });
    expect(result.isError).toBe(false);
    expect(requestedUrl).toBe("https://example.com:8443/docs");
  });

  // ── SSRF protection: direct IP/hostname blocking ──────────────

  test("blocks localhost targets unless explicitly enabled", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({
      url: "http://localhost:3000/health",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing to fetch local/private network target",
    );
    expect(called).toBe(false);
  });

  test("blocks 127.0.0.1 loopback targets", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({
      url: "http://127.0.0.1:8080/admin",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing to fetch local/private network target",
    );
    expect(called).toBe(false);
  });

  test("blocks 10.x.x.x private network targets", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({
      url: "http://10.0.0.1/internal",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing to fetch local/private network target",
    );
    expect(called).toBe(false);
  });

  test("blocks 192.168.x.x private network targets", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({ url: "http://192.168.1.1/" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing to fetch local/private network target",
    );
    expect(called).toBe(false);
  });

  test("blocks 172.16-31.x.x private network targets", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({ url: "http://172.16.0.1/" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing to fetch local/private network target",
    );
    expect(called).toBe(false);
  });

  test("blocks 169.254.x.x link-local targets", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({
      url: "http://169.254.169.254/latest/meta-data/",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing to fetch local/private network target",
    );
    expect(called).toBe(false);
  });

  test("blocks 0.0.0.0 targets", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({ url: "http://0.0.0.0/" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing to fetch local/private network target",
    );
    expect(called).toBe(false);
  });

  test("blocks cloud metadata endpoint (metadata.google.internal)", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({
      url: "http://metadata.google.internal/computeMetadata/v1/",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing to fetch local/private network target",
    );
    expect(called).toBe(false);
  });

  test("blocks .local mDNS suffix targets", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({
      url: "http://my-nas.local/admin",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing to fetch local/private network target",
    );
    expect(called).toBe(false);
  });

  test("blocks CGNAT range 100.64-127.x.x targets", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({
      url: "http://100.100.100.100/",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing to fetch local/private network target",
    );
    expect(called).toBe(false);
  });

  test("blocks IPv4 limited broadcast targets unless explicitly enabled", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({
      url: "http://255.255.255.255/",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing to fetch local/private network target",
    );
    expect(called).toBe(false);
  });

  test("blocks IPv4 multicast targets unless explicitly enabled", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({ url: "http://224.0.0.1/" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing to fetch local/private network target",
    );
    expect(called).toBe(false);
  });

  test("blocks IPv4 benchmarking targets unless explicitly enabled", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({ url: "http://198.18.0.10/" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing to fetch local/private network target",
    );
    expect(called).toBe(false);
  });

  test("allows public IP addresses", async () => {
    const result = await executeWithMockFetch(
      { url: "http://93.184.216.34/page" },
      {
        resolveHostAddresses: async () => ["93.184.216.34"],
        requestExecutor: async () =>
          new Response("public content", {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" },
          }),
      },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("public content");
  });

  test("allows public hostnames that resolve to public IPs", async () => {
    const result = await executeWithMockFetch(
      { url: "https://example.com/page" },
      {
        resolveHostAddresses: async () => ["93.184.216.34"],
        requestExecutor: async () =>
          new Response("public content", {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" },
          }),
      },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("public content");
  });

  // ── SSRF protection: DNS rebinding ────────────────────────────

  test("blocks hostnames that resolve to private addresses unless explicitly enabled", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch(
      { url: "https://evil.example.com/health" },
      {
        resolveHostAddresses: async () => ["10.0.0.5"],
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "resolves to local/private network address 10.0.0.5",
    );
    expect(called).toBe(false);
  });

  test("blocks hostnames that resolve to loopback via DNS rebinding", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch(
      { url: "https://rebind.example.com/steal" },
      {
        resolveHostAddresses: async () => ["127.0.0.1"],
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "resolves to local/private network address 127.0.0.1",
    );
    expect(called).toBe(false);
  });

  test("blocks hostnames that resolve to IPv6 loopback via DNS", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch(
      { url: "https://evil.example.com/steal" },
      {
        resolveHostAddresses: async () => ["::1"],
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "resolves to local/private network address ::1",
    );
    expect(called).toBe(false);
  });

  test("blocks hostnames resolving to link-local 169.254.x.x (AWS metadata)", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch(
      { url: "https://evil.example.com/metadata" },
      {
        resolveHostAddresses: async () => ["169.254.169.254"],
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "resolves to local/private network address 169.254.169.254",
    );
    expect(called).toBe(false);
  });

  test("blocks when any resolved address is private (mixed public/private DNS)", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch(
      { url: "https://dual.example.com/" },
      {
        resolveHostAddresses: async () => ["93.184.216.34", "192.168.1.1"],
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "resolves to local/private network address 192.168.1.1",
    );
    expect(called).toBe(false);
  });

  // ── SSRF protection: redirect-to-internal-IP ──────────────────

  test("blocks redirects to 10.x.x.x private targets", async () => {
    let callCount = 0;
    globalThis.fetch = (async (_url: string) => {
      callCount++;
      if (callCount === 1) {
        return new Response("", {
          status: 302,
          headers: { location: "http://10.0.0.1/internal" },
        });
      }
      return new Response("should-not-be-fetched", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({
      url: "https://example.com/start",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing redirect to local/private network target",
    );
    expect(callCount).toBe(1);
  });

  test("blocks redirects to 192.168.x.x private targets", async () => {
    let callCount = 0;
    globalThis.fetch = (async (_url: string) => {
      callCount++;
      if (callCount === 1) {
        return new Response("", {
          status: 302,
          headers: { location: "http://192.168.0.1/admin" },
        });
      }
      return new Response("should-not-be-fetched", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({
      url: "https://example.com/start",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing redirect to local/private network target",
    );
    expect(callCount).toBe(1);
  });

  test("blocks redirects to 169.254.169.254 (cloud metadata via redirect)", async () => {
    let callCount = 0;
    globalThis.fetch = (async (_url: string) => {
      callCount++;
      if (callCount === 1) {
        return new Response("", {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        });
      }
      return new Response("should-not-be-fetched", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({
      url: "https://example.com/start",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing redirect to local/private network target",
    );
    expect(callCount).toBe(1);
  });

  test("blocks redirect chain where intermediate hop resolves to private IP", async () => {
    let callCount = 0;

    const result = await executeWithMockFetch(
      { url: "https://example.com/start" },
      {
        resolveHostAddresses: async (hostname) => {
          if (hostname === "example.com") return ["93.184.216.34"];
          if (hostname === "evil-redirect.example") return ["192.168.1.100"];
          return ["93.184.216.34"];
        },
        requestExecutor: async (_url, _requestOptions) => {
          callCount++;
          if (callCount === 1) {
            return new Response("", {
              status: 302,
              headers: { location: "https://evil-redirect.example/steal" },
            });
          }
          return new Response("should-not-be-fetched", {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "resolves to local/private network address 192.168.1.100",
    );
    expect(callCount).toBe(1);
  });

  test("blocks redirect to non-http protocol", async () => {
    let callCount = 0;
    globalThis.fetch = (async (_url: string) => {
      callCount++;
      if (callCount === 1) {
        return new Response("", {
          status: 302,
          headers: { location: "file:///etc/passwd" },
        });
      }
      return new Response("should-not-be-fetched", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({
      url: "https://example.com/start",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing redirect to unsupported protocol",
    );
    expect(callCount).toBe(1);
  });

  test("blocks excessive redirects", async () => {
    let callCount = 0;
    globalThis.fetch = (async (_url: string) => {
      callCount++;
      return new Response("", {
        status: 302,
        headers: { location: `https://example.com/hop${callCount}` },
      });
    }) as any;

    const result = await executeWithMockFetch({
      url: "https://example.com/start",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Too many redirects");
  });

  test("blocks hostnames that resolve to private addresses unless explicitly enabled", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch(
      { url: "https://example.com/health" },
      {
        resolveHostAddresses: async (hostname) =>
          hostname === "example.com" ? ["127.0.0.1"] : ["93.184.216.34"],
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "resolves to local/private network address 127.0.0.1",
    );
    expect(called).toBe(false);
  });

  test("times out while resolving initial host before any request is sent", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch(
      { url: "https://example.com/health", timeout_seconds: 1 },
      {
        resolveHostAddresses: async () => await new Promise<string[]>(() => {}),
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("web fetch timed out after 1s");
    expect(called).toBe(false);
  });

  test("pins outbound requests to pre-resolved addresses when allow_private_network is false", async () => {
    const resolvedAddresses: string[] = [];

    const result = await executeWithMockFetch(
      { url: "https://example.com/health" },
      {
        resolveHostAddresses: async () => ["93.184.216.34"],
        requestExecutor: async (_url, requestOptions) => {
          resolvedAddresses.push(requestOptions.resolvedAddress ?? "");
          return new Response("ok", {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        },
      },
    );

    expect(result.isError).toBe(false);
    expect(resolvedAddresses).toEqual(["93.184.216.34"]);
  });

  test("retries pinned requests across resolved addresses when earlier addresses fail", async () => {
    const resolvedAddresses: string[] = [];

    const result = await executeWithMockFetch(
      { url: "https://example.com/health" },
      {
        resolveHostAddresses: async () => ["2001:db8::1", "93.184.216.34"],
        requestExecutor: async (_url, requestOptions) => {
          resolvedAddresses.push(requestOptions.resolvedAddress ?? "");
          if (requestOptions.resolvedAddress === "2001:db8::1") {
            throw new Error("connect ECONNREFUSED");
          }
          return new Response("ok", {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        },
      },
    );

    expect(result.isError).toBe(false);
    expect(resolvedAddresses).toEqual(["2001:db8::1", "93.184.216.34"]);
  });

  test("includes URL userinfo credentials in authorization header for pinned requests", async () => {
    let authorizationHeader = "";

    const result = await executeWithMockFetch(
      { url: "https://user%20name:p%40ss@example.com/protected" },
      {
        resolveHostAddresses: async () => ["93.184.216.34"],
        requestExecutor: async (_url, requestOptions) => {
          authorizationHeader = requestOptions.headers.authorization ?? "";
          return new Response("ok", {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        },
      },
    );

    expect(result.isError).toBe(false);
    expect(authorizationHeader).toBe(
      `Basic ${Buffer.from("user name:p@ss", "utf8").toString("base64")}`,
    );
  });

  test("requests identity encoding for pinned requests", async () => {
    let acceptEncodingHeader = "";

    const result = await executeWithMockFetch(
      { url: "https://example.com/protected" },
      {
        resolveHostAddresses: async () => ["93.184.216.34"],
        requestExecutor: async (_url, requestOptions) => {
          acceptEncodingHeader =
            requestOptions.headers["Accept-Encoding"] ?? "";
          return new Response("ok", {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        },
      },
    );

    expect(result.isError).toBe(false);
    expect(acceptEncodingHeader).toBe("identity");
  });

  test("strips URL userinfo before default fetch execution while preserving authorization header", async () => {
    let requestedUrl = "";
    let authorizationHeader = "";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      requestedUrl = url;
      authorizationHeader =
        new Headers(init?.headers).get("authorization") ?? "";
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWebFetch({
      url: "https://user%20name:p%40ss@example.com/protected",
      allow_private_network: true,
    });

    expect(result.isError).toBe(false);
    expect(requestedUrl).toBe("https://example.com/protected");
    expect(authorizationHeader).toBe(
      `Basic ${Buffer.from("user name:p@ss", "utf8").toString("base64")}`,
    );
  });

  test("redacts URL userinfo in output metadata", async () => {
    const username = "demo";
    const credential = ["c", "r", "e", "d", "1", "2", "3"].join("");
    const credentialedUrl = new URL("https://example.com/protected");
    credentialedUrl.username = username;
    credentialedUrl.password = credential;

    const result = await executeWithMockFetch(
      { url: credentialedUrl.href },
      {
        resolveHostAddresses: async () => ["93.184.216.34"],
        requestExecutor: async () =>
          new Response("ok", {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" },
          }),
      },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain(
      "Requested URL: https://example.com/protected",
    );
    expect(result.content).toContain(
      "Final URL: https://example.com/protected",
    );
    expect(result.content).not.toContain("demo:cred123@");
  });

  test("redacts URL userinfo in resolution error messages", async () => {
    const username = "demo";
    const credential = ["c", "r", "e", "d", "1", "2", "3"].join("");
    const credentialedUrl = new URL("https://example.com/protected");
    credentialedUrl.username = username;
    credentialedUrl.password = credential;

    const result = await executeWithMockFetch(
      { url: credentialedUrl.href },
      {
        resolveHostAddresses: async () => [],
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "while fetching https://example.com/protected",
    );
    expect(result.content).not.toContain("demo:cred123@");
  });

  test("allows hostnames that resolve to private addresses when allow_private_network=true", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch(
      { url: "https://example.com/health", allow_private_network: true },
      {
        resolveHostAddresses: async () => ["127.0.0.1"],
      },
    );
    expect(result.isError).toBe(false);
    expect(called).toBe(true);
  });

  test("blocks subdomain localhost targets unless explicitly enabled", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({
      url: "http://foo.localhost:3000/health",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing to fetch local/private network target",
    );
    expect(called).toBe(false);
  });

  test("blocks bracketed IPv6 localhost targets unless explicitly enabled", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({
      url: "http://[::1]:3000/health",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing to fetch local/private network target",
    );
    expect(called).toBe(false);
  });

  test("blocks IPv4-mapped IPv6 localhost targets unless explicitly enabled", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({
      url: "http://[::ffff:127.0.0.1]:3000/health",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing to fetch local/private network target",
    );
    expect(called).toBe(false);
  });

  test("blocks IPv4-compatible IPv6 localhost targets unless explicitly enabled", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({
      url: "http://[::7f00:1]:3000/health",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing to fetch local/private network target",
    );
    expect(called).toBe(false);
  });

  test("blocks IPv6 multicast localhost targets unless explicitly enabled", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({
      url: "http://[ff02::1]:3000/health",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing to fetch local/private network target",
    );
    expect(called).toBe(false);
  });

  test("blocks IPv6 site-local targets unless explicitly enabled", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({
      url: "http://[fec0::1]:3000/health",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing to fetch local/private network target",
    );
    expect(called).toBe(false);
  });

  test("allows localhost when allow_private_network=true", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("local ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({
      url: "http://localhost:3000/health",
      allow_private_network: true,
    });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("local ok");
    expect(called).toBe(true);
  });

  test("extracts readable text and metadata from HTML", async () => {
    globalThis.fetch = (async () =>
      new Response(
        [
          "<html><head>",
          "<title>Example Title</title>",
          '<meta name="description" content="Example Description">',
          "</head><body>",
          '<script>window.evil = "ignore me";</script>',
          "<h1>Hello</h1><p>World</p>",
          "</body></html>",
        ].join(""),
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      )) as any;

    const result = await executeWithMockFetch({ url: "https://example.com" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Title: Example Title");
    expect(result.content).toContain("Description: Example Description");
    expect(result.content).toContain("Hello");
    expect(result.content).toContain("World");
    expect(result.content).not.toContain("window.evil");
  });

  test("extracts full meta descriptions that contain apostrophes", async () => {
    globalThis.fetch = (async () =>
      new Response(
        [
          "<html><head>",
          `<meta name="description" content="We've updated our privacy policy">`,
          "</head><body>Body</body></html>",
        ].join(""),
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      )) as any;

    const result = await executeWithMockFetch({ url: "https://example.com" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain(
      `Description: We've updated our privacy policy`,
    );
  });

  test("extracts full og:description when quoted value contains double quotes", async () => {
    globalThis.fetch = (async () =>
      new Response(
        [
          "<html><head>",
          `<meta content='She said "hello" today' property='og:description'>`,
          "</head><body>Body</body></html>",
        ].join(""),
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      )) as any;

    const result = await executeWithMockFetch({ url: "https://example.com" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Description: She said "hello" today');
  });

  test("keeps malformed decimal entities unchanged", async () => {
    globalThis.fetch = (async () =>
      new Response("<html><body><p>Value: &#1a;</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as any;

    const result = await executeWithMockFetch({
      url: "https://example.com/entities",
    });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Value: &#1a;");
  });

  test("supports character windowing with start_index and max_chars", async () => {
    globalThis.fetch = (async () =>
      new Response("ABCDEFGHIJKLMNOPQRSTUVWXYZ", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })) as any;

    const result = await executeWithMockFetch({
      url: "https://example.com/letters",
      start_index: 5,
      max_chars: 4,
    });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Character Window: 5-9 of 26");
    expect(result.content).toContain("FGHI");
    expect(result.status).toContain("Output truncated by max_chars=4.");
  });

  test("rejects binary-like content types", async () => {
    globalThis.fetch = (async () =>
      new Response("PNGDATA", {
        status: 200,
        headers: { "content-type": "image/png" },
      })) as any;

    const result = await executeWithMockFetch({
      url: "https://example.com/image.png",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unsupported content type");
  });

  test("rejects binary mime types even when parameters look text-like", async () => {
    globalThis.fetch = (async () =>
      new Response("BINARYDATA", {
        status: 200,
        headers: {
          "content-type": "application/octet-stream; profile=text/plain",
        },
      })) as any;

    const result = await executeWithMockFetch({
      url: "https://example.com/download",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unsupported content type");
  });

  test("returns error results for non-2xx responses", async () => {
    globalThis.fetch = (async () =>
      new Response("missing page", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
        statusText: "Not Found",
      })) as any;

    const result = await executeWithMockFetch({
      url: "https://example.com/missing",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Error: HTTP 404");
    expect(result.content).toContain("missing page");
  });

  test("blocks redirects to localhost/private targets when allow_private_network is false", async () => {
    let callCount = 0;
    globalThis.fetch = (async (_url: string) => {
      callCount++;
      if (callCount === 1) {
        return new Response("", {
          status: 302,
          headers: { location: "http://localhost:3000/internal" },
        });
      }
      return new Response("should-not-be-fetched", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({
      url: "https://example.com/start",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing redirect to local/private network target",
    );
    expect(callCount).toBe(1);
  });

  test("blocks redirects to IPv4 benchmarking targets when allow_private_network is false", async () => {
    let callCount = 0;
    globalThis.fetch = (async (_url: string) => {
      callCount++;
      if (callCount === 1) {
        return new Response("", {
          status: 302,
          headers: { location: "http://198.18.0.10/internal" },
        });
      }
      return new Response("should-not-be-fetched", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({
      url: "https://example.com/start",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing redirect to local/private network target",
    );
    expect(callCount).toBe(1);
  });

  test("pins redirect hops to their own pre-resolved addresses when allow_private_network is false", async () => {
    let callCount = 0;
    const resolvedAddresses: string[] = [];

    const result = await executeWithMockFetch(
      { url: "https://example.com/start" },
      {
        resolveHostAddresses: async (hostname) => {
          if (hostname === "example.com") return ["93.184.216.34"];
          if (hostname === "redirect.example") return ["203.0.113.8"];
          return ["93.184.216.34"];
        },
        requestExecutor: async (_url, requestOptions) => {
          callCount++;
          resolvedAddresses.push(requestOptions.resolvedAddress ?? "");
          if (callCount === 1) {
            return new Response("", {
              status: 302,
              headers: { location: "https://redirect.example/internal" },
            });
          }
          return new Response("ok", {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        },
      },
    );

    expect(result.isError).toBe(false);
    expect(resolvedAddresses).toEqual(["93.184.216.34", "203.0.113.8"]);
  });

  test("blocks redirects to subdomain localhost targets when allow_private_network is false", async () => {
    let callCount = 0;
    globalThis.fetch = (async (_url: string) => {
      callCount++;
      if (callCount === 1) {
        return new Response("", {
          status: 302,
          headers: { location: "http://foo.localhost:3000/internal" },
        });
      }
      return new Response("should-not-be-fetched", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({
      url: "https://example.com/start",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing redirect to local/private network target",
    );
    expect(callCount).toBe(1);
  });

  test("blocks redirects when target host resolves to private addresses and allow_private_network is false", async () => {
    let callCount = 0;
    globalThis.fetch = (async (_url: string) => {
      callCount++;
      if (callCount === 1) {
        return new Response("", {
          status: 302,
          headers: { location: "https://internal.example/internal" },
        });
      }
      return new Response("should-not-be-fetched", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch(
      { url: "https://example.com/start" },
      {
        resolveHostAddresses: async (hostname) => {
          if (hostname === "example.com") return ["93.184.216.34"];
          if (hostname === "internal.example") return ["10.0.0.8"];
          return ["93.184.216.34"];
        },
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "resolves to local/private network address 10.0.0.8",
    );
    expect(callCount).toBe(1);
  });

  test("times out while resolving redirect host before following the redirect", async () => {
    let callCount = 0;
    const result = await executeWithMockFetch(
      { url: "https://example.com/start", timeout_seconds: 1 },
      {
        resolveHostAddresses: async (hostname) => {
          if (hostname === "example.com") return ["93.184.216.34"];
          return await new Promise<string[]>(() => {});
        },
        requestExecutor: async () => {
          callCount++;
          return new Response("", {
            status: 302,
            headers: { location: "https://redirect.example/internal" },
          });
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("web fetch timed out after 1s");
    expect(callCount).toBe(1);
  });

  test("blocks redirects to IPv4-mapped IPv6 private targets when allow_private_network is false", async () => {
    let callCount = 0;
    globalThis.fetch = (async (_url: string) => {
      callCount++;
      if (callCount === 1) {
        return new Response("", {
          status: 302,
          headers: { location: "http://[::ffff:7f00:1]:3000/internal" },
        });
      }
      return new Response("should-not-be-fetched", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({
      url: "https://example.com/start",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing redirect to local/private network target",
    );
    expect(callCount).toBe(1);
  });

  test("blocks redirects to IPv4-compatible IPv6 private targets when allow_private_network is false", async () => {
    let callCount = 0;
    globalThis.fetch = (async (_url: string) => {
      callCount++;
      if (callCount === 1) {
        return new Response("", {
          status: 302,
          headers: { location: "http://[::7f00:1]:3000/internal" },
        });
      }
      return new Response("should-not-be-fetched", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({
      url: "https://example.com/start",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing redirect to local/private network target",
    );
    expect(callCount).toBe(1);
  });

  test("allows redirects to localhost/private targets when allow_private_network is true", async () => {
    let callCount = 0;
    globalThis.fetch = (async (_url: string) => {
      callCount++;
      if (callCount === 1) {
        return new Response("", {
          status: 302,
          headers: { location: "http://localhost:3000/internal" },
        });
      }
      return new Response("internal ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as any;

    const result = await executeWithMockFetch({
      url: "https://example.com/start",
      allow_private_network: true,
    });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("internal ok");
    expect(result.status).toContain("Followed 1 redirect(s).");
    expect(callCount).toBe(2);
  });

  test("Accept header includes text/markdown with highest priority", async () => {
    let capturedAcceptHeader = "";

    const result = await executeWithMockFetch(
      { url: "https://example.com/doc" },
      {
        resolveHostAddresses: async () => ["93.184.216.34"],
        requestExecutor: async (_url, requestOptions) => {
          capturedAcceptHeader = requestOptions.headers["Accept"] ?? "";
          return new Response("ok", {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        },
      },
    );

    expect(result.isError).toBe(false);
    // text/markdown should appear first (highest priority, no q-value)
    expect(capturedAcceptHeader.startsWith("text/markdown")).toBe(true);
    // text/html should have a lower q-value
    expect(capturedAcceptHeader).toContain("text/html;q=0.9");
  });

  test("markdown responses pass through without HTML conversion", async () => {
    const markdownContent = [
      "# Title",
      "",
      "Some **bold** text and `inline code`.",
      "",
      "```javascript",
      "const x = 42;",
      "```",
      "",
      "[Link text](https://example.com)",
    ].join("\n");

    const result = await executeWithMockFetch(
      { url: "https://example.com/readme.md" },
      {
        resolveHostAddresses: async () => ["93.184.216.34"],
        requestExecutor: async () =>
          new Response(markdownContent, {
            status: 200,
            headers: { "content-type": "text/markdown; charset=utf-8" },
          }),
      },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("# Title");
    expect(result.content).toContain("**bold**");
    expect(result.content).toContain("```javascript");
    expect(result.content).toContain("const x = 42;");
    expect(result.content).toContain("[Link text](https://example.com)");
    expect(result.content).toContain("Mode: markdown");
  });

  test("markdown responses preserve indentation", async () => {
    const markdownContent = [
      "# Code Examples",
      "",
      "    indented code block",
      "    with multiple lines",
      "",
      "- top item",
      "  - sub-item",
      "    - deep sub-item",
      "",
      "```python",
      "  def hello():",
      '      print("world")',
      "```",
    ].join("\n");

    const result = await executeWithMockFetch(
      { url: "https://example.com/docs.md" },
      {
        resolveHostAddresses: async () => ["93.184.216.34"],
        requestExecutor: async () =>
          new Response(markdownContent, {
            status: 200,
            headers: { "content-type": "text/markdown" },
          }),
      },
    );

    expect(result.isError).toBe(false);
    // normalizeMarkdown preserves indentation unlike normalizeText
    expect(result.content).toContain("    indented code block");
    expect(result.content).toContain("    with multiple lines");
    expect(result.content).toContain("  - sub-item");
    expect(result.content).toContain("    - deep sub-item");
    expect(result.content).toContain("  def hello():");
    expect(result.content).toContain('      print("world")');
  });

  test("x-markdown-tokens header is surfaced in output", async () => {
    const result = await executeWithMockFetch(
      { url: "https://example.com/doc.md" },
      {
        resolveHostAddresses: async () => ["93.184.216.34"],
        requestExecutor: async () =>
          new Response("# Hello", {
            status: 200,
            headers: {
              "content-type": "text/markdown",
              "x-markdown-tokens": "3150",
            },
          }),
      },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Markdown-Tokens: 3150");
  });

  test("non-markdown responses still get HTML extraction as before", async () => {
    globalThis.fetch = (async () =>
      new Response(
        [
          "<html><head>",
          "<title>HTML Page</title>",
          "</head><body>",
          '<script>window.evil = "ignore me";</script>',
          "<h1>Hello</h1><p>World</p>",
          "</body></html>",
        ].join(""),
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      )) as any;

    const result = await executeWithMockFetch({ url: "https://example.com" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Title: HTML Page");
    expect(result.content).toContain("Hello");
    expect(result.content).toContain("World");
    expect(result.content).not.toContain("window.evil");
    expect(result.content).toContain("Mode: extracted");
  });

  test("markdown responses skip HTML metadata extraction", async () => {
    const markdownWithHtmlLikeStrings = [
      "# My Document",
      "",
      "This mentions a <title>Fake Title</title> tag in markdown.",
      "",
      '<meta name="description" content="Fake Description">',
      "",
      "Regular markdown content.",
    ].join("\n");

    const result = await executeWithMockFetch(
      { url: "https://example.com/doc.md" },
      {
        resolveHostAddresses: async () => ["93.184.216.34"],
        requestExecutor: async () =>
          new Response(markdownWithHtmlLikeStrings, {
            status: 200,
            headers: { "content-type": "text/markdown; charset=utf-8" },
          }),
      },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Mode: markdown");
    // No Title/Description metadata should be extracted from markdown content
    expect(result.content).not.toContain("Title: Fake Title");
    expect(result.content).not.toContain("Description: Fake Description");
    // The raw markdown content should still be present
    expect(result.content).toContain("<title>Fake Title</title>");
    expect(result.content).toContain("Regular markdown content.");
  });

  test("suggests JS rendering may be needed when HTML page returns very little text content", async () => {
    const spaHtml =
      '<!doctype html><html><head><title>My App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>';
    const result = await executeWithMockFetch(
      { url: "https://example.com/spa" },
      {
        resolveHostAddresses: async () => ["93.184.216.34"],
        requestExecutor: async () =>
          new Response(spaHtml, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Extracted text content is very short");
    expect(result.content).toContain("JavaScript rendering");
  });

  test("does not suggest browser skill when HTML page has substantial content", async () => {
    const richHtml = `<!doctype html><html><head><title>Docs</title></head><body><p>${"Lorem ipsum dolor sit amet. ".repeat(20)}</p></body></html>`;
    const result = await executeWithMockFetch(
      { url: "https://example.com/docs" },
      {
        resolveHostAddresses: async () => ["93.184.216.34"],
        requestExecutor: async () =>
          new Response(richHtml, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      },
    );

    expect(result.isError).toBe(false);
    expect(result.content).not.toContain(
      "Extracted text content is very short",
    );
  });

  test("does not suggest JS rendering notice in raw mode even for sparse HTML", async () => {
    const spaHtml =
      '<!doctype html><html><head><title>My App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>';
    const result = await executeWithMockFetch(
      { url: "https://example.com/spa", raw: true },
      {
        resolveHostAddresses: async () => ["93.184.216.34"],
        requestExecutor: async () =>
          new Response(spaHtml, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      },
    );

    expect(result.isError).toBe(false);
    expect(result.content).not.toContain(
      "Extracted text content is very short",
    );
  });
});
