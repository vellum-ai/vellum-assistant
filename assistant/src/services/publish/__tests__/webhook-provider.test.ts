/**
 * The generic HTTP publish provider: what it sends, what it accepts back, and
 * how it reports an endpoint that is unset, unreachable, or answering garbage.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { PublishWebhookConfig } from "../../../config/schemas/apps.js";
import type { AppPublishMeta } from "../types.js";

let webhook: PublishWebhookConfig = {
  url: "https://deploy.example.com/publish",
  unpublishUrl: "",
  unpublishMethod: "DELETE",
  timeoutMs: 60_000,
};
let isPlatform = false;

mock.module("../../../config/loader.js", () => ({
  getConfig: () => ({ apps: { publish: { provider: "webhook", webhook } } }),
}));

mock.module("../../../config/env-registry.js", () => ({
  getIsPlatform: () => isPlatform,
}));

const { webhookPublishProvider } = await import("../webhook-provider.js");

const META: AppPublishMeta = {
  appId: "app-123",
  name: "Budget Tracker",
  slug: "budget-tracker",
  previousDeploymentId: "dep-old",
};

const originalFetch = globalThis.fetch;

function stubFetch(
  handler: (request: Request) => Promise<Response> | Response,
): { calls: Request[] } {
  const calls: Request[] = [];
  globalThis.fetch = mock(async (input: unknown, init: unknown) => {
    const request = new Request(input as string, init as RequestInit);
    calls.push(request);
    return handler(request);
  }) as unknown as typeof fetch;
  return { calls };
}

beforeEach(() => {
  webhook = {
    url: "https://deploy.example.com/publish",
    unpublishUrl: "",
    unpublishMethod: "DELETE",
    timeoutMs: 60_000,
  };
  isPlatform = false;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("webhookPublishProvider.deploy", () => {
  test("POSTs the html plus app metadata and returns the endpoint's url", async () => {
    const { calls } = stubFetch(() =>
      Response.json({ url: "https://app.example.com", deploymentId: "dep-1" }),
    );

    const result = await webhookPublishProvider.deploy(
      "<html>hi</html>",
      META,
      null,
    );

    expect(result).toEqual({
      url: "https://app.example.com",
      deploymentId: "dep-1",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://deploy.example.com/publish");
    expect(calls[0].method).toBe("POST");
    expect(await calls[0].json()).toEqual({
      appId: "app-123",
      name: "Budget Tracker",
      slug: "budget-tracker",
      previousDeploymentId: "dep-old",
      html: "<html>hi</html>",
    });
  });

  test("sends a bearer token when one is supplied and none when it is not", async () => {
    const withToken = stubFetch(() =>
      Response.json({ url: "https://a.example.com", deploymentId: "d" }),
    );
    await webhookPublishProvider.deploy("<html/>", META, "secret-token");
    expect(withToken.calls[0].headers.get("authorization")).toBe(
      "Bearer secret-token",
    );

    const withoutToken = stubFetch(() =>
      Response.json({ url: "https://a.example.com", deploymentId: "d" }),
    );
    await webhookPublishProvider.deploy("<html/>", META, null);
    expect(withoutToken.calls[0].headers.get("authorization")).toBeNull();
  });

  test("reports the status and body of a non-2xx response", async () => {
    stubFetch(() => new Response("no room left", { status: 507 }));

    await expect(
      webhookPublishProvider.deploy("<html/>", META, null),
    ).rejects.toThrow("Publish webhook failed (507): no room left");
  });

  test("rejects a 2xx body that is not the documented shape", async () => {
    stubFetch(() => Response.json({ deployment: { url: "https://x.test" } }));

    await expect(
      webhookPublishProvider.deploy("<html/>", META, null),
    ).rejects.toThrow("unexpected body");
  });

  test("rejects a 2xx body that is not JSON at all", async () => {
    stubFetch(() => new Response("<html>oops</html>", { status: 200 }));

    await expect(
      webhookPublishProvider.deploy("<html/>", META, null),
    ).rejects.toThrow("unexpected body");
  });

  test("does not follow a redirect off the configured endpoint", async () => {
    const { calls } = stubFetch((request) => {
      expect(request.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      });
    });

    await expect(
      webhookPublishProvider.deploy("<html/>", META, null),
    ).rejects.toThrow("Publish webhook failed (302)");
    expect(calls).toHaveLength(1);
  });

  test("names the config key when no url is configured", async () => {
    webhook = { ...webhook, url: "" };
    const { calls } = stubFetch(() => Response.json({}));

    await expect(
      webhookPublishProvider.deploy("<html/>", META, null),
    ).rejects.toThrow("apps.publish.webhook.url is not set");
    expect(calls).toHaveLength(0);
  });

  test("rejects a url that is not http(s)", async () => {
    webhook = { ...webhook, url: "file:///etc/passwd" };
    const { calls } = stubFetch(() => Response.json({}));

    await expect(
      webhookPublishProvider.deploy("<html/>", META, null),
    ).rejects.toThrow("must be an http(s) URL");
    expect(calls).toHaveLength(0);
  });

  test("allows a private address when self-hosted and blocks it on platform", async () => {
    webhook = { ...webhook, url: "http://127.0.0.1:8080/publish" };

    stubFetch(() =>
      Response.json({ url: "http://local.test", deploymentId: "d" }),
    );
    await expect(
      webhookPublishProvider.deploy("<html/>", META, null),
    ).resolves.toEqual({ url: "http://local.test", deploymentId: "d" });

    isPlatform = true;
    const blocked = stubFetch(() => Response.json({}));
    await expect(
      webhookPublishProvider.deploy("<html/>", META, null),
    ).rejects.toThrow("private or local network address");
    expect(blocked.calls).toHaveLength(0);
  });
});

describe("webhookPublishProvider.unpublish", () => {
  test("sends the deployment id to the publish url by default", async () => {
    const { calls } = stubFetch(() => new Response(null, { status: 204 }));

    await webhookPublishProvider.unpublish?.(META, null);

    expect(calls[0].url).toBe("https://deploy.example.com/publish");
    expect(calls[0].method).toBe("DELETE");
    expect(await calls[0].json()).toEqual({
      appId: "app-123",
      name: "Budget Tracker",
      slug: "budget-tracker",
      deploymentId: "dep-old",
    });
  });

  test("uses the dedicated endpoint and method when configured", async () => {
    webhook = {
      ...webhook,
      unpublishUrl: "https://deploy.example.com/teardown",
      unpublishMethod: "POST",
    };
    const { calls } = stubFetch(() => new Response(null, { status: 200 }));

    await webhookPublishProvider.unpublish?.(META, "tok");

    expect(calls[0].url).toBe("https://deploy.example.com/teardown");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.get("authorization")).toBe("Bearer tok");
  });

  test("reports a non-2xx takedown", async () => {
    stubFetch(() => new Response("unknown deployment", { status: 404 }));

    await expect(
      webhookPublishProvider.unpublish?.(META, null),
    ).rejects.toThrow("Unpublish webhook failed (404): unknown deployment");
  });
});
