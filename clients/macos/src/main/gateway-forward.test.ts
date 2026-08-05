import { describe, expect, test } from "bun:test";

import {
  planGatewayForward,
  planPairedGatewayForward,
} from "./gateway-forward";

const allow =
  (...ports: number[]) =>
  () =>
    new Set<number>(ports);

const request = (
  pathname: string,
  init: { method?: string; origin?: string } = {},
) => ({
  url: `app://vellum.ai${pathname}`,
  method: init.method ?? "GET",
  headers: new Headers(
    init.origin === undefined ? {} : { origin: init.origin },
  ),
});

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
    expect(plan.url).toBe("https://gw.example.com/v1/foo?x=1");
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

  test("preserves non-ambient headers such as the guardian bearer", () => {
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
    expect(plan.headers.get("authorization")).toBe("Bearer guardian-token");
    expect(plan.headers.get("accept")).toBe("text/event-stream");
  });
});
