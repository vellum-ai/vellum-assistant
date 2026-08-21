/**
 * Tests for the tunnel reachability probe.
 *
 * Four properties carry the feature. First, `/healthz` decides liveness, so an
 * edge whose nginx answers while the gateway behind it does not reads
 * `unreachable`. Second, the config path decides pairing: an ingress that
 * answers it with anything but the pairing edge's own marked config reads
 * `unpairable`, while a config request that gets no answer at all leaves the
 * liveness verdict standing. Third, `foreign` is an accusation ("this URL now
 * fronts someone else's assistant"), so it is reserved for a positive mismatch
 * of two known ids and every skew case reads `healthy`. Fourth, the probe runs
 * often enough that a body it never parses has to be cancelled rather than
 * left to GC.
 *
 * Every case injects `fetchImpl`, so nothing here touches the network.
 */

import { describe, expect, test } from "bun:test";

import { probeTunnel } from "../tunnel-probe.js";

const BASE = "https://edge.example";

/** The marker the nginx pairing edge stamps into every config it serves. */
const PAIRING_EDGE_MODE = "remote-gateway";

type Route = { status?: number; body?: string; reject?: unknown };

/** `typeof fetch` carries extras (e.g. `preconnect`) a stub has no use for. */
function asFetch(
  stub: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return stub as unknown as typeof fetch;
}

/**
 * A hand-rolled response rather than a real one, so `body.cancel()` is
 * observable and stays callable after a failed `json()`.
 */
function stubResponse(route: Route, onCancel: () => void): Response {
  const status = route.status ?? 200;
  const text = route.body ?? "";
  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      cancel: async (): Promise<void> => {
        onCancel();
      },
    },
    json: async (): Promise<unknown> => JSON.parse(text),
  } as unknown as Response;
}

/** Serves canned responses per path, recording requests and body cancels. */
function stubFetch(routes: { healthz?: Route; config?: Route }): {
  fetchImpl: typeof fetch;
  urls: string[];
  cancelled: string[];
} {
  const urls: string[] = [];
  const cancelled: string[] = [];
  const fetchImpl = asFetch(async (input) => {
    const url = String(input);
    urls.push(url);
    const isHealth = url.endsWith("/healthz");
    const label = isHealth ? "healthz" : "config";
    const route = isHealth
      ? (routes.healthz ?? { body: "ok" })
      : (routes.config ?? { body: JSON.stringify({ mode: PAIRING_EDGE_MODE }) });
    if (route.reject !== undefined) {
      throw route.reject;
    }
    return stubResponse(route, () => cancelled.push(label));
  });
  return { fetchImpl, urls, cancelled };
}

/**
 * The probe accepts a served config only from an edge that marks itself, so a
 * case about identity alone carries the marker without saying so each time.
 */
function configBody(config: Record<string, unknown>): Route {
  return {
    status: 200,
    body: JSON.stringify({ mode: PAIRING_EDGE_MODE, ...config }),
  };
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

  test("healthy when the served id is padded with whitespace", async () => {
    // The recorded id is read through a trimming parser, so a served id that
    // only differs by padding is the same assistant, not a foreign one.
    const { fetchImpl } = stubFetch({
      config: configBody({ assistantId: "  asst_1  ", assistantName: " Ada " }),
    });
    await expect(
      probeTunnel({
        publicBaseUrl: BASE,
        expectedAssistantId: " asst_1 ",
        fetchImpl,
      }),
    ).resolves.toEqual({
      kind: "healthy",
      assistantId: "asst_1",
      assistantName: "Ada",
    });
  });

  test("unpairable when the config path answers with something else", async () => {
    // An SPA edge serves JSON here. Anything else means whatever is answering
    // is not the app that serves `/assistant/pair` either.
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
      kind: "unpairable",
      detail: "no assistant config served",
    });
  });

  test("unpairable when a served body carries no pairing-edge marker", async () => {
    // A bring-your-own front or a catch-all that answers every path with some
    // JSON is not the edge serving `/assistant/pair`, however well-formed its
    // body is.
    const { fetchImpl, cancelled } = stubFetch({
      config: { status: 200, body: "{}" },
    });
    await expect(
      probeTunnel({
        publicBaseUrl: BASE,
        expectedAssistantId: "asst_1",
        fetchImpl,
      }),
    ).resolves.toEqual({
      kind: "unpairable",
      detail: "not a pairing edge config",
    });
    expect(cancelled.sort()).toEqual(["config", "healthz"]);
  });

  test("healthy when the marked pairing edge identifies this assistant", async () => {
    // The whole served document, as `remoteWebIngressConfig` writes it.
    const { fetchImpl } = stubFetch({
      config: {
        status: 200,
        body: JSON.stringify({
          mode: PAIRING_EDGE_MODE,
          apiBaseUrl: "/v1",
          platformDisabled: true,
          disablePlatform: true,
          assistantName: "Ada",
          assistantId: "asst_1",
          hubUrl: "https://app.vellum.ai",
        }),
      },
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

  test("unpairable when the ingress does not serve the config path at all", async () => {
    // A tunnel pointed straight at the gateway: `/healthz` is the gateway's
    // own, and no pairing app sits in front of it.
    const { fetchImpl } = stubFetch({
      config: { status: 404, body: "not found" },
    });
    await expect(
      probeTunnel({
        publicBaseUrl: BASE,
        expectedAssistantId: "asst_1",
        fetchImpl,
      }),
    ).resolves.toEqual({ kind: "unpairable", detail: "HTTP 404" });
  });

  test("healthy when the config request rejects but the gateway answers", async () => {
    // A request that never lands says nothing about what the edge serves, so
    // the answered `/healthz` stands.
    const { fetchImpl } = stubFetch({
      config: { reject: new TypeError("fetch failed") },
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

  test("healthy when a slow edge answers /healthz but not the config", async () => {
    // Both requests share one deadline, so an edge that answers `/healthz`
    // just inside it loses the identity request to it. That is still a
    // working tunnel.
    const timeout = new DOMException("The operation timed out", "TimeoutError");
    const { fetchImpl } = stubFetch({ config: { reject: timeout } });
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

  test("surfaces the syscall code hidden under a generic fetch wrapper", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:80"), {
      code: "ECONNREFUSED",
    });
    const fetchImpl = asFetch(async () => {
      throw new TypeError("fetch failed", { cause });
    });
    await expect(
      probeTunnel({ publicBaseUrl: BASE, fetchImpl }),
    ).resolves.toEqual({ kind: "unreachable", detail: "ECONNREFUSED" });
  });

  test("falls back to the cause's message when neither level has a code", async () => {
    const fetchImpl = asFetch(async () => {
      throw new TypeError("fetch failed", {
        cause: new Error("getaddrinfo lookup failed"),
      });
    });
    await expect(
      probeTunnel({ publicBaseUrl: BASE, fetchImpl }),
    ).resolves.toEqual({
      kind: "unreachable",
      detail: "getaddrinfo lookup failed",
    });
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

  test.each(["not-a-url", "one.ngrok.app", "ftp://x", "https://x?a=b"])(
    "unreachable without a request for the malformed URL %p",
    async (publicBaseUrl) => {
      const { fetchImpl, urls } = stubFetch({});
      const result = await probeTunnel({ publicBaseUrl, fetchImpl });
      expect(result).toEqual({
        kind: "unreachable",
        detail: "not an http(s) URL",
      });
      expect(urls).toEqual([]);
    },
  );

  test("cancels the health body it never reads", async () => {
    const { fetchImpl, cancelled } = stubFetch({
      config: configBody({ assistantId: "asst_1" }),
    });
    await probeTunnel({ publicBaseUrl: BASE, fetchImpl });
    expect(cancelled).toEqual(["healthz"]);
  });

  test("cancels both bodies when the gateway is down", async () => {
    const { fetchImpl, cancelled } = stubFetch({
      healthz: { status: 502, body: "bad gateway" },
      config: configBody({ assistantId: "asst_1" }),
    });
    await probeTunnel({ publicBaseUrl: BASE, fetchImpl });
    expect(cancelled.sort()).toEqual(["config", "healthz"]);
  });

  test("cancels the config body it does not parse", async () => {
    const { fetchImpl, cancelled } = stubFetch({
      config: { status: 404, body: "not found" },
    });
    await probeTunnel({ publicBaseUrl: BASE, fetchImpl });
    expect(cancelled.sort()).toEqual(["config", "healthz"]);
  });

  test("survives a body that refuses to be cancelled", async () => {
    const fetchImpl = asFetch(async () =>
      Promise.resolve({
        ok: true,
        status: 200,
        body: {
          cancel: async (): Promise<void> => {
            throw new Error("already locked");
          },
        },
        json: async (): Promise<unknown> => ({
          mode: PAIRING_EDGE_MODE,
          assistantId: "asst_1",
        }),
      } as unknown as Response),
    );
    await expect(
      probeTunnel({ publicBaseUrl: BASE, fetchImpl }),
    ).resolves.toEqual({
      kind: "healthy",
      assistantId: "asst_1",
      assistantName: undefined,
    });
  });
});
