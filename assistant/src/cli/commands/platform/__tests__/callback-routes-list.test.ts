import { beforeEach, describe, expect, test } from "bun:test";

import {
  runPlatform,
  runPlatformCaught,
  setupPlatformIpcMock,
} from "./helpers.js";

const ipc = setupPlatformIpcMock();

describe("assistant platform callback-routes list", () => {
  beforeEach(() => {
    ipc.calls = [];
    ipc.response = { ok: true, result: { routes: [] } };
  });

  test("returns empty list when no routes registered", async () => {
    const out = await runPlatform(["callback-routes", "list", "--json"]);

    expect(ipc.calls[0][0]).toBe("platform_callback_routes_list");

    const parsed = JSON.parse(out.join(""));
    expect(parsed.ok).toBe(true);
    expect(parsed.routes).toEqual([]);
  });

  test("returns registered routes", async () => {
    const routes = [
      {
        id: "route-1",
        assistant_id: "019d6d4f-6dbd-779f-91d3-cb273b9429a5",
        type: "email",
        callback_path: "019d6d4f-6dbd-779f-91d3-cb273b9429a5/webhooks/email",
        callback_url:
          "https://dev-platform.vellum.ai/v1/gateway/callbacks/019d6d4f-6dbd-779f-91d3-cb273b9429a5/webhooks/email/",
      },
      {
        id: "route-2",
        assistant_id: "019d6d4f-6dbd-779f-91d3-cb273b9429a5",
        type: "telegram",
        callback_path: "019d6d4f-6dbd-779f-91d3-cb273b9429a5/webhooks/telegram",
        callback_url:
          "https://dev-platform.vellum.ai/v1/gateway/callbacks/019d6d4f-6dbd-779f-91d3-cb273b9429a5/webhooks/telegram/",
      },
    ];
    ipc.response = { ok: true, result: { routes } };

    const out = await runPlatform(["callback-routes", "list", "--json"]);

    const parsed = JSON.parse(out.join(""));
    expect(parsed.ok).toBe(true);
    expect(parsed.routes).toHaveLength(2);
    expect(parsed.routes[0].type).toBe("email");
    expect(parsed.routes[1].type).toBe("telegram");
  });

  test("fails when platform credentials are missing", async () => {
    ipc.response = {
      ok: false,
      error: "Platform credentials not available",
      statusCode: 422,
    };

    const { thrown } = await runPlatformCaught([
      "callback-routes",
      "list",
      "--json",
    ]);

    expect((thrown as Error).message).toBe("exitFromIpcResult called");
  });

  test("callback-routes register calls platform_callback_routes_register", async () => {
    ipc.response = {
      ok: true,
      result: {
        callbackUrl:
          "https://dev-platform.vellum.ai/v1/gateway/callbacks/asst/webhooks/telegram/",
        callbackPath: "webhooks/telegram",
        type: "telegram",
      },
    };

    const out = await runPlatform([
      "callback-routes",
      "register",
      "--path",
      "webhooks/telegram",
      "--type",
      "telegram",
      "--json",
    ]);

    expect(ipc.calls[0][0]).toBe("platform_callback_routes_register");
    expect((ipc.calls[0][1].body as Record<string, unknown>).path).toBe(
      "webhooks/telegram",
    );
    expect((ipc.calls[0][1].body as Record<string, unknown>).type).toBe(
      "telegram",
    );

    const parsed = JSON.parse(out.join(""));
    expect(parsed.ok).toBe(true);
    expect(parsed.callbackPath).toBe("webhooks/telegram");
  });
});
