/**
 * Tests for the tunnel reachability probe.
 *
 * Two properties carry the feature. First, healthy means the whole chain is
 * live, so an edge whose nginx answers while the gateway behind it does not
 * must read `unreachable`. Second, `foreign` is an accusation ("this URL now
 * fronts someone else's assistant"), so it is reserved for a positive
 * mismatch of two known ids and every skew case reads `healthy`.
 *
 * Every case injects `fetchImpl`, so nothing here touches the network.
 */

import { describe, expect, test } from "bun:test";

import { probeTunnel } from "../tunnel-probe.js";

const BASE = "https://edge.example";

type Route = { status?: number; body?: string };

/** `typeof fetch` carries extras (e.g. `preconnect`) a stub has no use for. */
function asFetch(
  stub: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return stub as unknown as typeof fetch;
}

/** Serves canned responses per path, and records the URLs it was asked for. */
function stubFetch(routes: { healthz?: Route; config?: Route }): {
  fetchImpl: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  const fetchImpl = asFetch(async (input) => {
    const url = String(input);
    urls.push(url);
    const route = url.endsWith("/healthz")
      ? (routes.healthz ?? { status: 200, body: "ok" })
      : (routes.config ?? { status: 200, body: "{}" });
    return new Response(route.body ?? "", { status: route.status ?? 200 });
  });
  return { fetchImpl, urls };
}

function configBody(config: Record<string, unknown>): Route {
  return { status: 200, body: JSON.stringify(config) };
}

describe("probeTunnel", () => {
  test("probes both the gateway path and the served config", async () => {
    const { fetchImpl, urls } = stubFetch({});
    await probeTunnel({ publicBaseUrl: `${BASE}/`, fetchImpl });
    expect(urls.sort()).toEqual([
      `${BASE}/assistant/__config`,
      `${BASE}/healthz`,
    ]);
  });

  test("healthy when the served id matches the recorded one", async () => {
    const { fetchImpl } = stubFetch({
      config: configBody({ assistantId: "asst_1", assistantName: "Ada" }),
    });
    await expect(
      probeTunnel({
        publicBaseUrl: BASE,
        expectedAssistantId: "asst_1",
        fetchImpl,
      }),
    ).resolves.toEqual({
      kind: "healthy",
      assistantId: "asst_1",
      assistantName: "Ada",
    });
  });

  test("healthy when the edge serves no id (edge predates the id)", async () => {
    const { fetchImpl } = stubFetch({
      config: configBody({ assistantName: "Ada" }),
    });
    await expect(
      probeTunnel({
        publicBaseUrl: BASE,
        expectedAssistantId: "asst_1",
        fetchImpl,
      }),
    ).resolves.toEqual({
      kind: "healthy",
      assistantId: undefined,
      assistantName: "Ada",
    });
  });

  test("healthy when no id was recorded, even though the edge serves one", async () => {
    const { fetchImpl } = stubFetch({
      config: configBody({ assistantId: "asst_2", assistantName: "Grace" }),
    });
    await expect(
      probeTunnel({ publicBaseUrl: BASE, fetchImpl }),
    ).resolves.toEqual({
      kind: "healthy",
      assistantId: "asst_2",
      assistantName: "Grace",
    });
  });

  test("foreign when two known ids differ", async () => {
    const { fetchImpl } = stubFetch({
      config: configBody({ assistantId: "asst_2", assistantName: "Grace" }),
    });
    await expect(
      probeTunnel({
        publicBaseUrl: BASE,
        expectedAssistantId: "asst_1",
        fetchImpl,
      }),
    ).resolves.toEqual({
      kind: "foreign",
      assistantId: "asst_2",
      assistantName: "Grace",
    });
  });

  test("healthy when the config body is not JSON", async () => {
    const { fetchImpl } = stubFetch({
      config: { status: 200, body: "<html>nope</html>" },
    });
    await expect(
      probeTunnel({
        publicBaseUrl: BASE,
        expectedAssistantId: "asst_1",
        fetchImpl,
      }),
    ).resolves.toEqual({
      kind: "healthy",
      assistantId: undefined,
      assistantName: undefined,
    });
  });

  test("unreachable when the request rejects", async () => {
    const fetchImpl = asFetch(async () => {
      throw new TypeError("Unable to connect");
    });
    await expect(
      probeTunnel({ publicBaseUrl: BASE, fetchImpl }),
    ).resolves.toEqual({ kind: "unreachable", detail: "Unable to connect" });
  });

  test("unreachable when nginx answers but the gateway is down", async () => {
    const { fetchImpl } = stubFetch({
      healthz: { status: 502, body: "bad gateway" },
      config: configBody({ assistantId: "asst_1" }),
    });
    await expect(
      probeTunnel({
        publicBaseUrl: BASE,
        expectedAssistantId: "asst_1",
        fetchImpl,
      }),
    ).resolves.toEqual({ kind: "unreachable", detail: "HTTP 502" });
  });

  test("unreachable when the probe times out", async () => {
    const fetchImpl = asFetch(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason);
          });
        }),
    );
    await expect(
      probeTunnel({ publicBaseUrl: BASE, timeoutMs: 5, fetchImpl }),
    ).resolves.toEqual({ kind: "unreachable", detail: "timeout" });
  });

  test("keeps the probed URL out of the failure detail", async () => {
    const fetchImpl = asFetch(async (input) => {
      throw new TypeError(`Failed to parse URL from ${String(input)}`);
    });
    const result = await probeTunnel({ publicBaseUrl: BASE, fetchImpl });
    expect(result.kind).toEqual("unreachable");
    expect(result).toHaveProperty("detail");
    expect((result as { detail: string }).detail).not.toContain(BASE);
  });

  test("unreachable when there is no URL to probe", async () => {
    const { fetchImpl, urls } = stubFetch({});
    const result = await probeTunnel({ publicBaseUrl: "   ", fetchImpl });
    expect(result).toEqual({
      kind: "unreachable",
      detail: "no public base URL",
    });
    expect(urls).toEqual([]);
  });
});
