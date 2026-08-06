import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  authorizePairedForwardHeaders,
  pairedGatewayTargetsFromLockfile,
  parsePairedGatewayUrl,
  readAllowedGatewayPorts,
  readPairedGatewayTargets,
  resolveGatewayProxyTarget,
  resolvePairedGatewayProxyTarget,
  sanitizePairedForwardHeaders,
} from "../gateway-proxy";

const pairedRejection = {
  kind: "reject",
  status: 403,
  message: "Assistant is not paired in lockfile",
} as const;

const allow =
  (...ports: number[]) =>
  () =>
    new Set<number>(ports);

describe("resolveGatewayProxyTarget", () => {
  test("passes non-gateway pathnames through untouched", () => {
    expect(resolveGatewayProxyTarget("/index.html", allow(8080))).toEqual({
      kind: "pass",
    });
    expect(resolveGatewayProxyTarget("/assistant/assets/app.js", allow())).toEqual({
      kind: "pass",
    });
  });

  test("forwards an allowlisted port to its loopback target", () => {
    expect(
      resolveGatewayProxyTarget("/__gateway/8080/v1/assistants", allow(8080)),
    ).toEqual({
      kind: "forward",
      target: { port: 8080, path: "/v1/assistants" },
    });
  });

  test("accepts the renderer's `/assistant` mount prefix", () => {
    expect(
      resolveGatewayProxyTarget("/assistant/__gateway/8080/auth/token", allow(8080)),
    ).toEqual({
      kind: "forward",
      target: { port: 8080, path: "/auth/token" },
    });
  });

  test("defaults a portless tail to the gateway root", () => {
    expect(resolveGatewayProxyTarget("/__gateway/8080", allow(8080))).toEqual({
      kind: "forward",
      target: { port: 8080, path: "/" },
    });
  });

  test("rejects ports outside the 1024–65535 range as invalid", () => {
    expect(resolveGatewayProxyTarget("/__gateway/80/v1", allow(80))).toEqual({
      kind: "invalid-port",
    });
    expect(resolveGatewayProxyTarget("/__gateway/70000/v1", allow(70000))).toEqual({
      kind: "invalid-port",
    });
  });

  test("forbids a well-formed port that isn't registered in the lockfile", () => {
    expect(
      resolveGatewayProxyTarget("/__gateway/9999/v1", allow(8080)),
    ).toEqual({ kind: "forbidden-port", port: 9999 });
  });

  test("forbids every gateway port when the allowlist is empty", () => {
    expect(resolveGatewayProxyTarget("/__gateway/8080/v1", allow())).toEqual({
      kind: "forbidden-port",
      port: 8080,
    });
  });

  test("allowlists ports from resources, loopback URLs, and docker runtimeUrls — never remote URLs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-proxy-test-"));
    const lockfilePath = path.join(dir, "assistants.json");
    try {
      fs.writeFileSync(
        lockfilePath,
        JSON.stringify({
          assistants: [
            { assistantId: "local-a", resources: { gatewayPort: 7830 } },
            { assistantId: "local-b", localUrl: "http://127.0.0.1:7831" },
            // Docker entries record their published gateway only as a
            // loopback runtimeUrl.
            {
              assistantId: "docker-a",
              cloud: "docker",
              runtimeUrl: "http://localhost:7930",
            },
            // Remote runtimeUrls (managed / gcp / paired) must never widen
            // the allowlist.
            {
              assistantId: "remote-a",
              cloud: "gcp",
              runtimeUrl: "https://assistant.example.com:8443",
            },
            // A paired entry is skipped wholesale: even a loopback runtimeUrl
            // (rejected on import, but possibly pre-existing) must not open
            // the loopback proxy to arbitrary local services.
            {
              assistantId: "paired-loopback",
              cloud: "paired",
              paired: true,
              runtimeUrl: "http://127.0.0.1:5432",
            },
          ],
        }),
      );
      expect(readAllowedGatewayPorts([lockfilePath])).toEqual(
        new Set([7830, 7831, 7930]),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("never reads the allowlist for non-gateway or invalid-port paths", () => {
    let reads = 0;
    const counting = () => {
      reads += 1;
      return new Set<number>([8080]);
    };
    resolveGatewayProxyTarget("/index.html", counting);
    resolveGatewayProxyTarget("/__gateway/80/v1", counting);
    expect(reads).toBe(0);
    resolveGatewayProxyTarget("/__gateway/8080/v1", counting);
    expect(reads).toBe(1);
  });
});

const pair =
  (entries: Record<string, string> = {}) =>
  () =>
    new Map<string, string>(Object.entries(entries));

describe("parsePairedGatewayUrl", () => {
  test("matches with and without the renderer's `/assistant` mount prefix", () => {
    expect(parsePairedGatewayUrl("/__gateway-paired/abc/v1/foo")).toEqual({
      match: true,
      valid: true,
      target: { assistantId: "abc", path: "/v1/foo", search: "" },
    });
    expect(
      parsePairedGatewayUrl("/assistant/__gateway-paired/abc/v1/foo"),
    ).toEqual({
      match: true,
      valid: true,
      target: { assistantId: "abc", path: "/v1/foo", search: "" },
    });
  });

  test("defaults a pathless tail to the gateway root", () => {
    expect(parsePairedGatewayUrl("/__gateway-paired/abc")).toEqual({
      match: true,
      valid: true,
      target: { assistantId: "abc", path: "/", search: "" },
    });
  });

  test("splits the query off the id instead of swallowing it", () => {
    expect(parsePairedGatewayUrl("/__gateway-paired/abc?x=1")).toEqual({
      match: true,
      valid: true,
      target: { assistantId: "abc", path: "/", search: "?x=1" },
    });
  });

  test("carries the query through on a pathful tail and drops a fragment", () => {
    expect(parsePairedGatewayUrl("/__gateway-paired/abc/v1/foo?x=1#frag")).toEqual({
      match: true,
      valid: true,
      target: { assistantId: "abc", path: "/v1/foo", search: "?x=1" },
    });
    expect(parsePairedGatewayUrl("/__gateway-paired/abc/v1#frag")).toEqual({
      match: true,
      valid: true,
      target: { assistantId: "abc", path: "/v1", search: "" },
    });
  });

  test("percent-decodes the assistant id", () => {
    expect(parsePairedGatewayUrl("/__gateway-paired/a%20b/v1")).toEqual({
      match: true,
      valid: true,
      target: { assistantId: "a b", path: "/v1", search: "" },
    });
  });

  test("treats malformed percent-encoding as invalid, not a crash", () => {
    expect(parsePairedGatewayUrl("/__gateway-paired/%zz/v1")).toEqual({
      match: true,
      valid: false,
    });
  });

  test("rejects dot segments in the tail, raw or percent-encoded", () => {
    for (const url of [
      "/__gateway-paired/abc/../secrets",
      "/__gateway-paired/abc/v1/../../secrets",
      "/__gateway-paired/abc/./v1",
      "/__gateway-paired/abc/%2e%2e/secrets",
      "/__gateway-paired/abc/%2E%2E/secrets",
      "/__gateway-paired/abc/%2e/v1",
      "/__gateway-paired/abc/v1/%zz",
    ]) {
      expect(parsePairedGatewayUrl(url)).toEqual({
        match: true,
        valid: false,
      });
    }
  });

  test("does not treat dot-containing filenames as traversal", () => {
    expect(parsePairedGatewayUrl("/__gateway-paired/abc/v1/file.json")).toEqual(
      {
        match: true,
        valid: true,
        target: { assistantId: "abc", path: "/v1/file.json", search: "" },
      },
    );
  });

  test("does not match non-paired pathnames", () => {
    expect(parsePairedGatewayUrl("/__gateway/8080/v1")).toEqual({
      match: false,
    });
    expect(parsePairedGatewayUrl("/index.html")).toEqual({ match: false });
  });
});

describe("resolvePairedGatewayProxyTarget", () => {
  test("passes non-paired pathnames through untouched", () => {
    expect(
      resolvePairedGatewayProxyTarget("/index.html", pair({ abc: "https://gw.example.com" })),
    ).toEqual({ kind: "pass" });
    expect(
      resolvePairedGatewayProxyTarget("/__gateway/8080/v1", pair()),
    ).toEqual({ kind: "pass" });
  });

  test("forwards a paired id to its runtimeUrl, preserving the query", () => {
    expect(
      resolvePairedGatewayProxyTarget(
        "/assistant/__gateway-paired/abc/v1/foo?x=1",
        pair({ abc: "https://gw.example.com" }),
      ),
    ).toEqual({
      kind: "forward",
      url: "https://gw.example.com/v1/foo?x=1",
      runtimeUrl: "https://gw.example.com",
      assistantId: "abc",
    });
  });

  test("forwards a query on a pathless tail instead of treating it as part of the id", () => {
    expect(
      resolvePairedGatewayProxyTarget(
        "/__gateway-paired/abc?x=1",
        pair({ abc: "https://gw.example.com" }),
      ),
    ).toEqual({
      kind: "forward",
      url: "https://gw.example.com/?x=1",
      runtimeUrl: "https://gw.example.com",
      assistantId: "abc",
    });
  });

  test("rejects a dot-segment traversal tail", () => {
    expect(
      resolvePairedGatewayProxyTarget(
        "/__gateway-paired/abc/../../secrets",
        pair({ abc: "https://gw.example.com/edge" }),
      ),
    ).toEqual(pairedRejection);
    expect(
      resolvePairedGatewayProxyTarget(
        "/__gateway-paired/abc/%2e%2e/secrets",
        pair({ abc: "https://gw.example.com/edge" }),
      ),
    ).toEqual(pairedRejection);
  });

  test("strips the runtimeUrl's trailing slashes and keeps its path prefix", () => {
    expect(
      resolvePairedGatewayProxyTarget(
        "/__gateway-paired/abc/v1/foo",
        pair({ abc: "https://gw.example.com/" }),
      ),
    ).toEqual({
      kind: "forward",
      url: "https://gw.example.com/v1/foo",
      runtimeUrl: "https://gw.example.com/",
      assistantId: "abc",
    });
    expect(
      resolvePairedGatewayProxyTarget(
        "/__gateway-paired/abc/v1/foo",
        pair({ abc: "https://gw.example.com/edge/" }),
      ),
    ).toEqual({
      kind: "forward",
      url: "https://gw.example.com/edge/v1/foo",
      runtimeUrl: "https://gw.example.com/edge/",
      assistantId: "abc",
    });
  });

  test("resolves a percent-encoded id against the decoded allowlist key", () => {
    expect(
      resolvePairedGatewayProxyTarget(
        "/__gateway-paired/a%20b/v1",
        pair({ "a b": "https://gw.example.com" }),
      ),
    ).toEqual({
      kind: "forward",
      url: "https://gw.example.com/v1",
      runtimeUrl: "https://gw.example.com",
      assistantId: "a b",
    });
  });

  test("rejects an id that isn't paired in the lockfile", () => {
    expect(
      resolvePairedGatewayProxyTarget(
        "/__gateway-paired/unknown/v1",
        pair({ abc: "https://gw.example.com" }),
      ),
    ).toEqual(pairedRejection);
  });

  test("rejects a malformed percent-encoded id", () => {
    expect(
      resolvePairedGatewayProxyTarget(
        "/__gateway-paired/%zz/v1",
        pair({ "%zz": "https://gw.example.com" }),
      ),
    ).toEqual(pairedRejection);
  });

  test("never reads the allowlist for non-paired paths", () => {
    let reads = 0;
    const counting = () => {
      reads += 1;
      return new Map<string, string>([["abc", "https://gw.example.com"]]);
    };
    resolvePairedGatewayProxyTarget("/index.html", counting);
    resolvePairedGatewayProxyTarget("/__gateway/8080/v1", counting);
    expect(reads).toBe(0);
    resolvePairedGatewayProxyTarget("/__gateway-paired/abc/v1", counting);
    expect(reads).toBe(1);
  });
});

describe("pairedGatewayTargetsFromLockfile", () => {
  test("maps paired entries with usable runtimeUrls, excluding everything else", () => {
    expect(
      pairedGatewayTargetsFromLockfile({
        assistants: [
          {
            assistantId: "paired-a",
            cloud: "paired",
            runtimeUrl: "https://gw.example.com",
          },
          {
            assistantId: "paired-b",
            cloud: "paired",
            runtimeUrl: "http://192.0.2.10:8443/edge",
          },
          // Non-paired entries never become forwardable.
          { assistantId: "local-a", cloud: "local" },
          {
            assistantId: "docker-a",
            cloud: "docker",
            runtimeUrl: "http://localhost:7930",
          },
          {
            assistantId: "remote-a",
            cloud: "gcp",
            runtimeUrl: "https://assistant.example.com:8443",
          },
          // Paired entries without a usable absolute http(s) runtimeUrl are
          // excluded rather than forwarded blind.
          { assistantId: "paired-no-url", cloud: "paired" },
          {
            assistantId: "paired-bad-scheme",
            cloud: "paired",
            runtimeUrl: "ssh://gw.example.com",
          },
          {
            assistantId: "paired-relative",
            cloud: "paired",
            runtimeUrl: "/not-absolute",
          },
          // Malformed entries are tolerated, not fatal.
          null,
          "not-an-object",
          { cloud: "paired", runtimeUrl: "https://gw.example.com" },
          {
            assistantId: "",
            cloud: "paired",
            runtimeUrl: "https://gw.example.com",
          },
        ],
      }),
    ).toEqual(
      new Map([
        ["paired-a", "https://gw.example.com"],
        ["paired-b", "http://192.0.2.10:8443/edge"],
      ]),
    );
  });

  test("returns an empty map for a lockfile with no assistants", () => {
    expect(pairedGatewayTargetsFromLockfile({ assistants: [] })).toEqual(
      new Map(),
    );
  });
});

describe("readPairedGatewayTargets", () => {
  const withLockfile = (
    contents: string,
    run: (lockfilePath: string) => void,
  ) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paired-gateway-test-"));
    const lockfilePath = path.join(dir, "assistants.json");
    try {
      fs.writeFileSync(lockfilePath, contents);
      run(lockfilePath);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  test("maps paired entries to their http(s) runtimeUrls, excluding everything else", () => {
    withLockfile(
      JSON.stringify({
        assistants: [
          {
            assistantId: "paired-a",
            cloud: "paired",
            runtimeUrl: "https://gw.example.com",
          },
          {
            assistantId: "paired-b",
            cloud: "paired",
            runtimeUrl: "http://192.0.2.10:8443/edge",
          },
          // Non-paired entries never become forwardable, loopback or not.
          { assistantId: "local-a", resources: { gatewayPort: 7830 } },
          {
            assistantId: "docker-a",
            cloud: "docker",
            runtimeUrl: "http://localhost:7930",
          },
          {
            assistantId: "remote-a",
            cloud: "gcp",
            runtimeUrl: "https://assistant.example.com:8443",
          },
          // Paired entries without a usable absolute http(s) runtimeUrl are
          // excluded rather than forwarded blind.
          { assistantId: "paired-no-url", cloud: "paired" },
          {
            assistantId: "paired-bad-scheme",
            cloud: "paired",
            runtimeUrl: "ssh://gw.example.com",
          },
          {
            assistantId: "paired-relative",
            cloud: "paired",
            runtimeUrl: "/not-absolute",
          },
          // Malformed entries are tolerated, not fatal.
          null,
          { cloud: "paired", runtimeUrl: "https://gw.example.com" },
        ],
      }),
      (lockfilePath) => {
        expect(readPairedGatewayTargets([lockfilePath])).toEqual(
          new Map([
            ["paired-a", "https://gw.example.com"],
            ["paired-b", "http://192.0.2.10:8443/edge"],
          ]),
        );
      },
    );
  });

  test("returns an empty map for malformed JSON", () => {
    withLockfile("not json", (lockfilePath) => {
      expect(readPairedGatewayTargets([lockfilePath])).toEqual(new Map());
    });
  });

  test("returns an empty map when no lockfile path exists", () => {
    expect(
      readPairedGatewayTargets(["/nonexistent/assistants.json"]),
    ).toEqual(new Map());
  });

  test("stops at the first parseable lockfile even when it yields no targets", () => {
    // The unpair write path targets the first lockfile path
    // (writeRawLockfile), so the allowlist must not fall through to a stale
    // legacy file just because the written file has no paired entries left.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paired-gateway-test-"));
    const primary = path.join(dir, "assistants.json");
    const legacy = path.join(dir, "legacy-assistants.json");
    try {
      fs.writeFileSync(primary, JSON.stringify({ assistants: [] }));
      fs.writeFileSync(
        legacy,
        JSON.stringify({
          assistants: [
            {
              assistantId: "paired-a",
              cloud: "paired",
              runtimeUrl: "https://gw.example.com",
            },
          ],
        }),
      );
      expect(readPairedGatewayTargets([primary, legacy])).toEqual(new Map());
      // A missing primary still falls through to the legacy file.
      fs.rmSync(primary);
      expect(readPairedGatewayTargets([primary, legacy])).toEqual(
        new Map([["paired-a", "https://gw.example.com"]]),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sanitizePairedForwardHeaders", () => {
  test("strips renderer authorization and browser-ambient headers", () => {
    const headers = new Headers({
      origin: "http://localhost:5173",
      referer: "http://localhost:5173/assistant",
      cookie: "sessionid=abc",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      authorization: "Bearer guardian-token",
      accept: "text/event-stream",
      "content-type": "application/json",
    });
    sanitizePairedForwardHeaders(headers);
    expect(headers.has("origin")).toBe(false);
    expect(headers.has("referer")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("sec-fetch-site")).toBe(false);
    expect(headers.has("sec-fetch-mode")).toBe(false);
    expect(headers.has("sec-fetch-dest")).toBe(false);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(headers.get("content-type")).toBe("application/json");
  });

  test("adds the ngrok interstitial bypass header", () => {
    const headers = new Headers({ authorization: "Bearer guardian-token" });
    sanitizePairedForwardHeaders(headers);
    expect(headers.get("ngrok-skip-browser-warning")).toBe("true");
  });
});

describe("authorizePairedForwardHeaders", () => {
  test("sanitizes before installing the host-owned bearer", async () => {
    const headers = new Headers({
      authorization: "Bearer renderer-token",
      cookie: "renderer-cookie=1",
      accept: "application/json",
    });

    const result = await authorizePairedForwardHeaders(
      "paired-a",
      "https://gw.example.com",
      headers,
      async (assistantId, runtimeUrl) => {
        expect(assistantId).toBe("paired-a");
        expect(runtimeUrl).toBe("https://gw.example.com");
        expect(headers.has("authorization")).toBe(false);
        expect(headers.has("cookie")).toBe(false);
        return { ok: true, accessToken: "host-token" };
      },
    );

    expect(result).toEqual({ ok: true });
    expect(headers.get("authorization")).toBe("Bearer host-token");
    expect(headers.get("accept")).toBe("application/json");
  });

  test("leaves renderer authorization stripped when token loading fails", async () => {
    const headers = new Headers({ authorization: "Bearer renderer-token" });

    const result = await authorizePairedForwardHeaders(
      "paired-a",
      "https://gw.example.com",
      headers,
      async () => ({ ok: false, status: 404, error: "Token not found" }),
    );

    expect(result).toEqual({
      ok: false,
      status: 404,
      error: "Token not found",
    });
    expect(headers.has("authorization")).toBe(false);
  });
});
