import { afterEach, expect, mock, test } from "bun:test";
import { AuthRateLimiter } from "../auth-rate-limiter.js";
import { createRouter } from "../http/router.js";
import { createDesktopControlRoutes } from "../http/routes/desktop-setup-proxy.js";
import {
  GUARDIAN_PRINCIPAL,
  makeConfig,
  mintEdgeToken,
} from "./runtime-stream-test-utils.js";

mock.module("../auth/guardian-bootstrap.js", () => ({
  findVellumGuardian: async () => ({ principalId: GUARDIAN_PRINCIPAL }),
}));
let runtime: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  runtime?.stop(true);
});

test("flat and scoped app controls require the guardian and forward structured actions", async () => {
  const received: {
    path: string;
    body: unknown;
    authorization: string | null;
  }[] = [];
  runtime = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      received.push({
        path: new URL(request.url).pathname,
        body: request.method === "POST" ? await request.json() : null,
        authorization: request.headers.get("authorization"),
      });
      return Response.json({ apps: [] });
    },
  });
  const router = createRouter(
    createDesktopControlRoutes(
      makeConfig({
        assistantRuntimeBaseUrl: `http://127.0.0.1:${runtime.port}`,
      }),
    ),
    { authRateLimiter: new AuthRateLimiter() },
  );
  for (const path of [
    "/v1/desktop/apps",
    "/v1/assistants/assistant-123/desktop/apps",
  ]) {
    for (const method of ["GET", "POST"]) {
      const request = (token?: string) =>
        new Request(`http://gateway.example.com${path}`, {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          ...(method === "POST"
            ? { body: JSON.stringify({ appId: "calculator", action: "add" }) }
            : {}),
        });
      for (const token of [undefined, mintEdgeToken("other-actor")]) {
        const req = request(token);
        const before = received.length;
        const response = await router(
          req,
          new URL(req.url),
          () => "203.0.113.1",
        );
        expect([401, 403]).toContain(response!.status);
        expect(received.length).toBe(before);
      }
      const req = request(mintEdgeToken(GUARDIAN_PRINCIPAL));
      expect(
        (await router(req, new URL(req.url), () => "203.0.113.1"))!.status,
      ).toBe(200);
      expect(received.at(-1)!.path).toBe("/v1/desktop/apps");
      if (method === "POST") {
        expect(received.at(-1)!.body).toEqual({
          appId: "calculator",
          action: "add",
        });
      }
      expect(received.at(-1)!.authorization).toStartWith("Bearer ");
    }
  }
});
