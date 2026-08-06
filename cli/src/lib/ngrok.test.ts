import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";

import {
  buildNgrokArgs,
  classifyExistingAgent,
  pickFreeLoopbackPort,
  pickMatchingTunnel,
  waitForNgrokUrl,
  type NgrokTunnel,
} from "./ngrok.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function tunnel(publicUrl: string, addr: string): NgrokTunnel {
  return { public_url: publicUrl, config: { addr } };
}

const foreignTunnel = tunnel("https://foreign.example.app", "localhost:7840");

describe("pickMatchingTunnel", () => {
  test("returns null when no tunnel targets the port", () => {
    expect(pickMatchingTunnel([foreignTunnel], 18080)).toBeNull();
  });

  test("picks the tunnel for the target port among foreign tunnels", () => {
    const tunnels = [
      foreignTunnel,
      tunnel("https://edge.example.app", "localhost:18080"),
    ];
    expect(pickMatchingTunnel(tunnels, 18080)).toBe("https://edge.example.app");
  });

  test("prefers HTTPS over HTTP for the same port", () => {
    const tunnels = [
      tunnel("http://edge.example.app", "127.0.0.1:18080"),
      tunnel("https://edge.example.app", "127.0.0.1:18080"),
    ];
    expect(pickMatchingTunnel(tunnels, 18080)).toBe("https://edge.example.app");
  });

  test("matches every supported addr spelling", () => {
    for (const addr of [
      "localhost:18080",
      "127.0.0.1:18080",
      "http://localhost:18080",
      "http://127.0.0.1:18080",
    ]) {
      expect(
        pickMatchingTunnel([tunnel("https://edge.example.app", addr)], 18080),
      ).toBe("https://edge.example.app");
    }
  });

  test("filters by domain when one is requested", () => {
    const tunnels = [
      tunnel("https://other.example.app", "localhost:18080"),
      tunnel("https://reserved.example.app", "localhost:18080"),
    ];
    expect(pickMatchingTunnel(tunnels, 18080, "reserved.example.app")).toBe(
      "https://reserved.example.app",
    );
    expect(pickMatchingTunnel(tunnels, 18080, "absent.example.app")).toBeNull();
  });

  test("a later domain match beats an earlier HTTPS tunnel on the same port", () => {
    // A foreign agent's tunnel is listed before the dedicated agent's entry;
    // with a reserved domain the domain match must be selected, not the
    // first HTTPS tunnel.
    const tunnels = [
      tunnel("https://foreign.example.app", "localhost:18080"),
      tunnel("https://reserved.example.app", "localhost:18080"),
    ];
    expect(pickMatchingTunnel(tunnels, 18080, "reserved.example.app")).toBe(
      "https://reserved.example.app",
    );
  });
});

describe("classifyExistingAgent", () => {
  test("returns none for an empty tunnel list", () => {
    expect(classifyExistingAgent([], 18080)).toBe("none");
  });

  test("returns reuse when a tunnel targets the port", () => {
    const tunnels = [
      foreignTunnel,
      tunnel("https://edge.example.app", "localhost:18080"),
    ];
    expect(classifyExistingAgent(tunnels, 18080)).toBe("reuse");
  });

  test("returns coexist when only foreign tunnels are listed", () => {
    expect(classifyExistingAgent([foreignTunnel], 18080)).toBe("coexist");
  });

  test("returns coexist when the port matches but the domain does not", () => {
    const tunnels = [tunnel("https://other.example.app", "localhost:18080")];
    expect(classifyExistingAgent(tunnels, 18080, "reserved.example.app")).toBe(
      "coexist",
    );
  });

  test("returns reuse when a later tunnel matches the reserved domain", () => {
    const tunnels = [
      tunnel("https://foreign.example.app", "localhost:18080"),
      tunnel("https://reserved.example.app", "localhost:18080"),
    ];
    expect(classifyExistingAgent(tunnels, 18080, "reserved.example.app")).toBe(
      "reuse",
    );
  });
});

describe("buildNgrokArgs", () => {
  test("builds base args without domain or web-addr", () => {
    expect(buildNgrokArgs(18080)).toEqual(["http", "18080", "--log=stdout"]);
  });

  test("appends --domain when a domain is given", () => {
    expect(buildNgrokArgs(18080, "reserved.example.app")).toEqual([
      "http",
      "18080",
      "--log=stdout",
      "--domain=reserved.example.app",
    ]);
  });

  test("appends --web-addr iff a web-addr port is given", () => {
    expect(buildNgrokArgs(18080, undefined, 41234)).toEqual([
      "http",
      "18080",
      "--log=stdout",
      "--web-addr=127.0.0.1:41234",
    ]);
    expect(buildNgrokArgs(18080, "reserved.example.app", 41234)).toEqual([
      "http",
      "18080",
      "--log=stdout",
      "--domain=reserved.example.app",
      "--web-addr=127.0.0.1:41234",
    ]);
  });
});

describe("pickFreeLoopbackPort", () => {
  test("returns a bindable loopback port", async () => {
    const port = await pickFreeLoopbackPort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);

    // The port is released and can be bound again.
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    });
  });
});

describe("waitForNgrokUrl", () => {
  /** Stub the agent API, recording each fetched URL. */
  function mockTunnelsFetch(tunnels: NgrokTunnel[]): string[] {
    const fetchedUrls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetchedUrls.push(String(input));
      return new Response(JSON.stringify({ tunnels }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    return fetchedUrls;
  }

  test("polls the default :4040 API when no apiUrl is given", async () => {
    const fetchedUrls = mockTunnelsFetch([
      tunnel("https://edge.example.app", "localhost:18080"),
    ]);

    const url = await waitForNgrokUrl(18080);

    expect(url).toBe("https://edge.example.app");
    expect(fetchedUrls).toEqual(["http://127.0.0.1:4040/api/tunnels"]);
  });

  test("polls the provided agent API and ignores foreign tunnels", async () => {
    const fetchedUrls = mockTunnelsFetch([
      foreignTunnel,
      tunnel("https://edge.example.app", "localhost:18080"),
    ]);

    const url = await waitForNgrokUrl(
      18080,
      undefined,
      "http://127.0.0.1:41234/api/tunnels",
    );

    expect(url).toBe("https://edge.example.app");
    expect(fetchedUrls).toEqual(["http://127.0.0.1:41234/api/tunnels"]);
  });

  test("times out when the agent never reports a matching tunnel", async () => {
    mockTunnelsFetch([foreignTunnel]);

    await expect(
      waitForNgrokUrl(18080, undefined, undefined, 1),
    ).rejects.toThrow("did not become available");
  });
});
