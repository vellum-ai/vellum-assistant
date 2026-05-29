import { describe, expect, test } from "bun:test";

import {
  buildStage1PlatformProxyHeaders,
  isStage1PlatformProxyEnabledForEnv,
  resolveStage1PlatformProxyRequest,
  stage1PlatformProxyResponseHeaders,
} from "./vite-plugin-local-mode";

describe("vite-plugin-local-mode / Stage 1 platform proxy", () => {
  test("reads the Stage 1 env flag", () => {
    expect(
      isStage1PlatformProxyEnabledForEnv({
        VITE_LOCAL_PLATFORM_PROXY_STAGE1: "true",
      }),
    ).toBe(true);
    expect(isStage1PlatformProxyEnabledForEnv({})).toBe(false);
  });

  test("matches assistant runtime routes and strips the app base path", () => {
    expect(
      resolveStage1PlatformProxyRequest(
        "/assistant/v1/assistants/local-1/conversations/?limit=25",
      ),
    ).toEqual({
      kind: "proxy",
      assistantId: "local-1",
      firstSegment: "conversations",
      targetPath: "/v1/assistants/local-1/conversations/?limit=25",
    });
  });

  test("ignores non-assistant routes", () => {
    expect(resolveStage1PlatformProxyRequest("/v1/feature-flags")).toBeNull();
  });

  test("rejects gateway auth and non-allowlisted assistant routes", () => {
    expect(
      resolveStage1PlatformProxyRequest("/v1/assistants/local-1/auth/token"),
    ).toEqual({ kind: "reject" });
    expect(
      resolveStage1PlatformProxyRequest("/v1/assistants/local-1/terminal/"),
    ).toEqual({ kind: "reject" });
  });

  test("rejects malformed assistant ids", () => {
    expect(
      resolveStage1PlatformProxyRequest(
        "/v1/assistants/local%2Fbad/conversations/",
      ),
    ).toEqual({ kind: "reject" });
  });

  test("injects gateway auth server-side and forwards only allowlisted headers", () => {
    const headers = buildStage1PlatformProxyHeaders(
      {
        accept: "text/event-stream",
        authorization: "Bearer browser-token",
        cookie: "sessionid=secret",
        origin: "https://platform.example",
        "x-csrf-token": "csrf",
        "x-vellum-client-id": "client-123",
      },
      18100,
      "server-gateway-token",
    );

    expect(headers).toEqual({
      accept: "text/event-stream",
      authorization: "Bearer server-gateway-token",
      host: "127.0.0.1:18100",
      "x-vellum-client-id": "client-123",
      "x-vellum-stage1-platform-proxy": "true",
    });
  });

  test("marks proxy responses and strips unsafe upstream headers", () => {
    const headers = stage1PlatformProxyResponseHeaders({
      "content-type": "application/json",
      "set-cookie": "gateway=secret",
      connection: "keep-alive",
    });

    expect(headers).toEqual({
      "content-type": "application/json",
      "x-vellum-stage1-platform-proxy": "true",
    });
  });
});
