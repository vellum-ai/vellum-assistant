import { describe, expect, test } from "bun:test";

import {
  authorizePairedGatewayForwardPlan,
  executeGatewayForwardPlan,
  planGatewayForward,
  planPairedGatewayForward,
  type GatewayForwardPlan,
} from "./gateway-forward";
import {
  PROXY_ERROR_HEADER,
  PROXY_NETWORK_ERROR_CODE,
} from "./platform-forward";

const allow =
  (...ports: number[]) =>
  () =>
    new Set<number>(ports);

const request = (
  pathname: string,
  init: {
    method?: string;
    origin?: string;
    headers?: Record<string, string>;
  } = {},
) => {
  const headers = new Headers(init.headers);
  if (init.origin !== undefined) {
    headers.set("origin", init.origin);
  }
  return {
    url: `app://vellum.ai${pathname}`,
    method: init.method ?? "GET",
    headers,
  };
};

describe("planGatewayForward", () => {
  test("passes non-gateway requests through to static serving", () => {
    expect(
      planGatewayForward(request("/assistant/assets/app.js"), allow(8080)),
    ).toEqual({ kind: "pass" });
  });

  test("rejects an out-of-range port with 400", () => {
    expect(planGatewayForward(request("/__gateway/80/v1"), allow(80))).toEqual({
      kind: "reject",
      status: 400,
      message: "Port must be between 1024 and 65535",
    });
  });

  test("rejects a port absent from the lockfile allowlist with 403", () => {
    expect(
      planGatewayForward(request("/__gateway/9999/v1"), allow(8080)),
    ).toEqual({
      kind: "reject",
      status: 403,
      message: "Gateway port is not active in lockfile",
    });
  });

  test("forwards an allowlisted port to its loopback target", () => {
    const plan = planGatewayForward(
      request("/assistant/__gateway/8080/v1/assistants"),
      allow(8080),
    );
    expect(plan.kind).toBe("forward");
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.url).toBe("http://127.0.0.1:8080/v1/assistants");
    expect(plan.method).toBe("GET");
    expect(plan.hasBody).toBe(false);
  });

  test("rewrites the renderer's app:// Origin to the gateway's loopback origin", () => {
    // The gateway token route only accepts loopback web origins; forwarding
    // the packaged app's `app://` origin verbatim would be rejected with 403.
    const plan = planGatewayForward(
      request("/assistant/__gateway/8080/auth/token", {
        method: "POST",
        origin: "app://vellum.ai",
      }),
      allow(8080),
    );
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.headers.get("origin")).toBe("http://127.0.0.1:8080");
    expect(plan.hasBody).toBe(true);
  });

  test("sets a loopback Origin even when the renderer sent none", () => {
    const plan = planGatewayForward(
      request("/__gateway/8080/v1/stream"),
      allow(8080),
    );
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.headers.get("origin")).toBe("http://127.0.0.1:8080");
  });

  test("preserves non-Origin headers such as the guardian bearer", () => {
    const req = {
      url: "app://vellum.ai/assistant/__gateway/8080/auth/token",
      method: "POST",
      headers: new Headers({
        origin: "app://vellum.ai",
        authorization: "Bearer guardian-token",
        "content-type": "application/json",
      }),
    };
    const plan = planGatewayForward(req, allow(8080));
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.headers.get("authorization")).toBe("Bearer guardian-token");
    expect(plan.headers.get("content-type")).toBe("application/json");
  });
});

const pair =
  (entries: Record<string, string> = {}) =>
  () =>
    new Map<string, string>(Object.entries(entries));

describe("planPairedGatewayForward", () => {
  test("passes non-paired requests through to static serving", () => {
    expect(
      planPairedGatewayForward(
        request("/assistant/assets/app.js"),
        pair({ abc: "https://gw.example.com" }),
      ),
    ).toEqual({ kind: "pass" });
    // The loopback gateway path belongs to planGatewayForward, not this plan.
    expect(
      planPairedGatewayForward(request("/__gateway/8080/v1"), pair()),
    ).toEqual({ kind: "pass" });
  });

  test("rejects an assistant absent from the lockfile pairings with 403", () => {
    expect(
      planPairedGatewayForward(
        request("/__gateway-paired/unknown/v1"),
        pair({ abc: "https://gw.example.com" }),
      ),
    ).toEqual({
      kind: "reject",
      status: 403,
      message: "Assistant is not paired in lockfile",
    });
  });

  test("forwards a paired assistant to its runtimeUrl, preserving the query", () => {
    const plan = planPairedGatewayForward(
      request("/assistant/__gateway-paired/abc/v1/foo?x=1"),
      pair({ abc: "https://gw.example.com" }),
    );
    if (plan.kind !== "forward") {
      throw new Error("expected forward");
    }
    if (!plan.remote) {
      throw new Error("expected paired forward");
    }
    expect(plan.url).toBe("https://gw.example.com/v1/foo?x=1");
    expect(plan.assistantId).toBe("abc");
    expect(plan.runtimeUrl).toBe("https://gw.example.com");
    expect(plan.method).toBe("GET");
    expect(plan.hasBody).toBe(false);
  });

  test("strips the browser-ambient headers on the server-to-server hop", () => {
    const req = {
      url: "app://vellum.ai/__gateway-paired/abc/v1/events",
      method: "POST",
      headers: new Headers({
        origin: "app://vellum.ai",
        referer: "app://vellum.ai/assistant",
        cookie: "sessionid=abc",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
      }),
    };
    const plan = planPairedGatewayForward(
      req,
      pair({ abc: "https://gw.example.com" }),
    );
    if (plan.kind !== "forward") {
      throw new Error("expected forward");
    }
    expect(plan.headers.has("origin")).toBe(false);
    expect(plan.headers.has("referer")).toBe(false);
    expect(plan.headers.has("cookie")).toBe(false);
    expect(plan.headers.has("sec-fetch-site")).toBe(false);
    expect(plan.headers.has("sec-fetch-mode")).toBe(false);
    expect(plan.hasBody).toBe(true);
  });

  test("rejects a dot-segment traversal tail with 403", () => {
    expect(
      planPairedGatewayForward(
        request("/__gateway-paired/abc/%2e%2e/secrets"),
        pair({ abc: "https://gw.example.com/edge" }),
      ),
    ).toEqual({
      kind: "reject",
      status: 403,
      message: "Assistant is not paired in lockfile",
    });
  });

  test("strips renderer authorization while preserving ordinary headers", () => {
    const req = {
      url: "app://vellum.ai/assistant/__gateway-paired/abc/v1/foo",
      method: "GET",
      headers: new Headers({
        origin: "app://vellum.ai",
        authorization: "Bearer guardian-token",
        accept: "text/event-stream",
      }),
    };
    const plan = planPairedGatewayForward(
      req,
      pair({ abc: "https://gw.example.com" }),
    );
    if (plan.kind !== "forward") {
      throw new Error("expected forward");
    }
    expect(plan.headers.has("authorization")).toBe(false);
    expect(plan.headers.get("accept")).toBe("text/event-stream");
  });

  test("injects the host-owned guardian bearer after sanitization", async () => {
    const plan = planPairedGatewayForward(
      request("/assistant/__gateway-paired/abc/v1/foo", {
        headers: { authorization: "Bearer renderer-token" },
      }),
      pair({ abc: "https://gw.example.com" }),
    );

    const authorized = await authorizePairedGatewayForwardPlan(
      plan,
      async (assistantId, runtimeUrl) => {
        expect(assistantId).toBe("abc");
        expect(runtimeUrl).toBe("https://gw.example.com");
        return { ok: true, accessToken: "host-token" };
      },
    );

    if (authorized.kind !== "forward") {
      throw new Error("expected forward");
    }
    expect(authorized.headers.get("authorization")).toBe("Bearer host-token");
  });

  test("rejects before forwarding when the host cannot read the bearer", async () => {
    const plan = planPairedGatewayForward(
      request("/__gateway-paired/abc/v1/foo"),
      pair({ abc: "https://gw.example.com" }),
    );

    expect(
      await authorizePairedGatewayForwardPlan(plan, async () => ({
        ok: false,
        status: 404,
        error: "Guardian token not found",
      })),
    ).toEqual({
      kind: "reject",
      status: 404,
      message: "Guardian token not found",
    });
  });
});

describe("executeGatewayForwardPlan", () => {
  const noBody = { body: null };
  const quietRetries = { sleep: async () => {}, onError: () => {} };

  const forwardPlan = (
    planner: () => GatewayForwardPlan,
  ): Extract<GatewayForwardPlan, { kind: "forward" }> => {
    const plan = planner();
    if (plan.kind !== "forward") {
      throw new Error("expected forward");
    }
    return plan;
  };

  const loopbackPlan = (method = "GET") =>
    forwardPlan(() =>
      planGatewayForward(
        request("/__gateway/8080/v1/foo", { method }),
        allow(8080),
      ),
    );

  const pairedPlan = (method = "GET") =>
    forwardPlan(() =>
      planPairedGatewayForward(
        request("/__gateway-paired/abc/v1/foo", { method }),
        pair({ abc: "https://gw.example.com" }),
      ),
    );

  const rejectingFetcher =
    (message: string, calls?: { count: number }) => async () => {
      if (calls) {
        calls.count += 1;
      }
      throw new Error(message);
    };

  test("returns null on a pass plan so the caller serves static assets", () => {
    expect(
      executeGatewayForwardPlan({ kind: "pass" }, noBody, async () => {
        throw new Error("must not fetch");
      }),
    ).toBeNull();
  });

  test("turns a reject plan into its error response", async () => {
    const result = executeGatewayForwardPlan(
      { kind: "reject", status: 403, message: "Forbidden" },
      noBody,
      async () => {
        throw new Error("must not fetch");
      },
    );
    if (!(result instanceof Response)) {
      throw new Error("expected a Response");
    }
    expect(result.status).toBe(403);
    expect(await result.text()).toBe("Forbidden");
  });

  test("forwards with manual redirects and a half-duplex streamed body", async () => {
    const body = new ReadableStream<Uint8Array>();
    const seen: { url: string; init: RequestInit & { duplex?: "half" } }[] = [];
    const plan = loopbackPlan("POST");
    await executeGatewayForwardPlan(plan, { body }, async (url, init) => {
      seen.push({ url, init });
      return new Response("ok");
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://127.0.0.1:8080/v1/foo");
    expect(seen[0]!.init.method).toBe("POST");
    expect(seen[0]!.init.headers).toBe(plan.headers);
    expect(seen[0]!.init.body).toBe(body);
    expect(seen[0]!.init.duplex).toBe("half");
    expect(seen[0]!.init.redirect).toBe("manual");
  });

  test("omits body and duplex for bodiless requests", async () => {
    const seen: (RequestInit & { duplex?: "half" })[] = [];
    await executeGatewayForwardPlan(pairedPlan(), noBody, async (_url, init) => {
      seen.push(init);
      return new Response("ok");
    });

    expect(seen[0]!.body).toBeUndefined();
    expect(seen[0]!.duplex).toBeUndefined();
    expect(seen[0]!.redirect).toBe("manual");
  });

  test("passes the upstream Response through by identity, body unconsumed", async () => {
    // SSE and chunked transfers rely on the streaming Response reaching the
    // renderer verbatim; buffering here would stall live streams.
    const upstream = new Response(new ReadableStream<Uint8Array>(), {
      headers: { "content-type": "text/event-stream" },
    });
    const result = await executeGatewayForwardPlan(
      pairedPlan(),
      noBody,
      async () => upstream,
    );

    expect(result).toBe(upstream);
    expect(upstream.bodyUsed).toBe(false);
  });

  test("a loopback fetch rejection propagates to the caller", async () => {
    const result = executeGatewayForwardPlan(
      loopbackPlan(),
      noBody,
      rejectingFetcher("net::ERR_CONNECTION_REFUSED"),
    );
    await expect(result as Promise<Response>).rejects.toThrow(
      "net::ERR_CONNECTION_REFUSED",
    );
  });

  test("a paired fetch rejection becomes the structured 502", async () => {
    const result = await executeGatewayForwardPlan(
      pairedPlan(),
      noBody,
      rejectingFetcher("net::ERR_TUNNEL_CONNECTION_FAILED"),
      quietRetries,
    );

    if (!(result instanceof Response)) {
      throw new Error("expected a Response");
    }
    expect(result.status).toBe(502);
    expect(result.headers.get("content-type")).toBe("application/json");
    expect(result.headers.get(PROXY_ERROR_HEADER)).toBe("network");
    const body = (await result.json()) as Record<string, unknown>;
    expect(body.code).toBe(PROXY_NETWORK_ERROR_CODE);
    expect(typeof body.detail).toBe("string");
    expect(body.detail).not.toContain("net::");
  });

  test("a paired GET retries a transient failure once, then returns the 502", async () => {
    const calls = { count: 0 };
    const result = await executeGatewayForwardPlan(
      pairedPlan(),
      noBody,
      rejectingFetcher("net::ERR_NETWORK_CHANGED", calls),
      quietRetries,
    );

    expect(calls.count).toBe(2);
    expect((result as Response).status).toBe(502);
  });

  test("a paired POST is not retried: its body stream is single-use", async () => {
    const calls = { count: 0 };
    const result = await executeGatewayForwardPlan(
      pairedPlan("POST"),
      noBody,
      rejectingFetcher("net::ERR_NETWORK_CHANGED", calls),
      quietRetries,
    );

    expect(calls.count).toBe(1);
    expect((result as Response).status).toBe(502);
  });
});
