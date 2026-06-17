import { describe, expect, test } from "bun:test";

import { planGatewayForward } from "./gateway-forward";

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
