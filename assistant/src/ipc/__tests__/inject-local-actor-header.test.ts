/**
 * `injectLocalActorHeader` resolves the IPC caller's identity. Routes that
 * elevate trust gate on `"local"`, so a gateway-proxied remote request must
 * never resolve to `local`, even when it arrives with no verified principal
 * header (e.g. `runtimeProxyRequireAuth` disabled). The
 * `x-vellum-proxy-server: ipc` marker (forwarded by the gateway, never sent by
 * a direct CLI) distinguishes the two.
 *
 * The transport verifies no subject and serves no wire-exact URL, so the two
 * fields that carry those (`x-vellum-subject`, `rawUrl`) are dropped rather
 * than passed through from a caller that can reach the socket.
 */

import { describe, expect, test } from "bun:test";

import type { RouteHandlerArgs } from "../../runtime/routes/types.js";
import {
  AssistantIpcServer,
  injectLocalActorHeader,
} from "../assistant-server.js";

const SPOOFED_SUBJECT = "local:self:oauth-proxy.stripe_link";

describe("injectLocalActorHeader principal resolution", () => {
  test("a forwarded verified principal wins", () => {
    const out = injectLocalActorHeader({
      headers: { "x-vellum-principal-type": "actor" },
    });
    expect(out.headers?.["x-vellum-principal-type"]).toBe("actor");
  });

  test("gateway-proxied IPC with no principal resolves to svc_gateway, not local", () => {
    const out = injectLocalActorHeader({
      headers: { "x-vellum-proxy-server": "ipc" },
    });
    expect(out.headers?.["x-vellum-principal-type"]).toBe("svc_gateway");
  });

  test("a direct IPC caller (no proxy marker, no principal) defaults to local", () => {
    const out = injectLocalActorHeader({ headers: {} });
    expect(out.headers?.["x-vellum-principal-type"]).toBe("local");
  });
});

describe("injectLocalActorHeader identity sanitation", () => {
  test("drops a caller-supplied x-vellum-subject", () => {
    const out = injectLocalActorHeader({
      headers: { "x-vellum-subject": SPOOFED_SUBJECT },
    });
    expect(out.headers?.["x-vellum-subject"]).toBeUndefined();
  });

  test("drops the subject a gateway-proxied caller forwards", () => {
    const out = injectLocalActorHeader({
      headers: {
        "x-vellum-proxy-server": "ipc",
        "x-vellum-subject": SPOOFED_SUBJECT,
      },
    });
    expect(out.headers?.["x-vellum-subject"]).toBeUndefined();
  });

  test("drops a caller-supplied rawUrl", () => {
    const out = injectLocalActorHeader({
      rawUrl: { pathname: "/v1/oauth/proxy/stripe_link/v1/charges" },
    });
    expect(out.rawUrl).toBeUndefined();
  });

  test("leaves the caller's other params alone", () => {
    const out = injectLocalActorHeader({
      pathParams: { provider: "stripe_link" },
      queryParams: { limit: "1" },
    });
    expect(out.pathParams).toEqual({ provider: "stripe_link" });
    expect(out.queryParams).toEqual({ limit: "1" });
  });
});

/**
 * Every dispatched method funnels through `injectLocalActorHeader`, so the
 * spoofed values must be gone by the time a handler runs. `handleEnvelope` is
 * private; reach it through an interface cast (same pattern as
 * route-error-envelope.test.ts) and hand it a destroyed socket, which makes
 * the response write a no-op.
 */
type PrivateApi = {
  methods: Map<string, (args: RouteHandlerArgs) => unknown>;
  handleEnvelope(
    socket: unknown,
    reader: unknown,
    envelope: unknown,
    binary: Uint8Array | undefined,
  ): void;
};

describe("IPC dispatch", () => {
  test("a spoofed subject and rawUrl never reach the handler", () => {
    const server = new AssistantIpcServer() as unknown as PrivateApi;
    let received: RouteHandlerArgs | undefined;
    server.methods.set("identity_probe", (args) => {
      received = args;
      return null;
    });

    server.handleEnvelope(
      { destroyed: true },
      { isLegacy: false },
      {
        id: "req-1",
        method: "identity_probe",
        params: {
          headers: {
            "x-vellum-subject": SPOOFED_SUBJECT,
            "x-vellum-principal-type": "local",
          },
          pathParams: { provider: "stripe_link" },
          rawUrl: { pathname: "/v1/oauth/proxy/stripe_link/v1/charges" },
        },
      },
      undefined,
    );

    expect(received).toBeDefined();
    expect(received?.headers?.["x-vellum-subject"]).toBeUndefined();
    expect(received?.rawUrl).toBeUndefined();
    expect(received?.pathParams).toEqual({ provider: "stripe_link" });
  });
});
