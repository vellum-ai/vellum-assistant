/**
 * `resolveWebhookUrl`: the URL a plugin hands a vendor.
 *
 * The resolution order itself belongs to `resolveCallbackUrl`, which is spied
 * on here rather than reimplemented. Restating it would recreate the
 * duplication this module exists to remove. What is covered is what this
 * module adds: which plugin the route belongs to, the path it composes, the
 * registration type it derives, and what it refuses.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

let mockIsPlatform = false;

// Bun shares mocked modules across test files in a combined run, so the mock
// spreads the real module and overrides only what this file drives.
const actualEnvRegistry = await import("../config/env-registry.js");
mock.module("../config/env-registry.js", () => ({
  ...actualEnvRegistry,
  getIsPlatform: () => mockIsPlatform,
}));

const loader = await import("../config/loader.js");
const registration =
  await import("../inbound/platform-callback-registration.js");
const { resolveWebhookUrl } = await import("../plugin-api/webhook-url.js");
const { runInPluginContext } =
  await import("../plugins/plugin-execution-context.js");

describe("resolveWebhookUrl", () => {
  afterEach(() => {
    mockIsPlatform = false;
  });
  test("composes the plugin's namespaced path and delegates the tier choice", async () => {
    const spy = spyOn(registration, "resolveCallbackUrl").mockResolvedValue(
      "https://callbacks.vellum.ai/abc/webhooks/plugins/imessage/events-photon",
    );

    const url = await resolveWebhookUrl({
      plugin: "imessage",
      path: "events-photon",
    });

    expect(url).toBe(
      "https://callbacks.vellum.ai/abc/webhooks/plugins/imessage/events-photon/",
    );
    expect(spy.mock.calls[0]![1]).toBe(
      "webhooks/plugins/imessage/events-photon",
    );
    spy.mockRestore();
  });

  test("defaults to the plugin in context", async () => {
    // Hooks and tools run in plugin context, so the common caller passes no
    // plugin at all.
    const spy = spyOn(registration, "resolveCallbackUrl").mockResolvedValue(
      "https://example.test/x",
    );

    await runInPluginContext("imessage", () =>
      resolveWebhookUrl({ path: "events-comms" }),
    );

    expect(spy.mock.calls[0]![1]).toBe(
      "webhooks/plugins/imessage/events-comms",
    );
    spy.mockRestore();
  });

  test("an explicit plugin wins over the one in context", async () => {
    const spy = spyOn(registration, "resolveCallbackUrl").mockResolvedValue(
      "https://example.test/x",
    );

    await runInPluginContext("other", () =>
      resolveWebhookUrl({ plugin: "imessage", path: "events-comms" }),
    );

    expect(spy.mock.calls[0]![1]).toBe(
      "webhooks/plugins/imessage/events-comms",
    );
    spy.mockRestore();
  });

  test("says so when there is no plugin to attribute the route to", async () => {
    await expect(resolveWebhookUrl({ path: "events" })).rejects.toThrow(
      /No plugin is in context/,
    );
  });

  test("gives routes that share a slug distinct registration types", async () => {
    // The platform keys a callback route by type, so a collision has the
    // second registration replace the first. `events-v1` and `events_v1`
    // slugify identically.
    const spy = spyOn(registration, "resolveCallbackUrl").mockResolvedValue(
      "https://example.test/x",
    );

    await resolveWebhookUrl({ plugin: "imessage", path: "events-v1" });
    await resolveWebhookUrl({ plugin: "imessage", path: "events_v1" });

    const types = spy.mock.calls.map((call) => call[2]);
    expect(new Set(types).size).toBe(2);
    spy.mockRestore();
  });

  test("accepts the paths the gateway's route schema accepts", async () => {
    // A path this rejects but the gateway serves is a route a plugin can
    // install and then never resolve a URL for.
    const spy = spyOn(registration, "resolveCallbackUrl").mockResolvedValue(
      "https://example.test/x",
    );

    for (const path of [
      "events-photon",
      "events:v1",
      "hooks/@vendor",
      "a/b/c",
    ]) {
      await expect(
        resolveWebhookUrl({ plugin: "imessage", path }),
      ).resolves.toBeDefined();
    }
    spy.mockRestore();
  });

  test("refuses a plugin name or path that escapes the namespace", async () => {
    // The prefix is fixed so a plugin cannot claim another's routes. That only
    // holds if the segments cannot escape it either.
    for (const options of [
      { plugin: "../vellum", path: "events" },
      { plugin: "imessage", path: "../../admin" },
      { plugin: "imessage", path: "/events" },
      { plugin: "imessage", path: "events/" },
      { plugin: "imessage", path: "events?x=1" },
      { plugin: "imessage", path: "%2e%2e/admin" },
      { plugin: "imessage", path: "" },
    ]) {
      await expect(resolveWebhookUrl(options)).rejects.toThrow(/Invalid/);
    }
  });

  test("hands the vendor a URL with a trailing slash", async () => {
    // Django in front of managed callbacks canonicalizes onto `/`. A vendor
    // given the slashless spelling is 301'd, and clients that follow a 301
    // on POST typically retry as GET and drop the body.
    const spy = spyOn(registration, "resolveCallbackUrl").mockResolvedValue(
      "https://callbacks.vellum.ai/abc/webhooks/plugins/imessage/events-comms/",
    );

    await expect(
      resolveWebhookUrl({ plugin: "imessage", path: "events-comms" }),
    ).resolves.toBe(
      "https://callbacks.vellum.ai/abc/webhooks/plugins/imessage/events-comms/",
    );
    expect(spy.mock.calls[0]![1]).toBe(
      "webhooks/plugins/imessage/events-comms",
    );
    spy.mockRestore();
  });

  test("hands out an ingress URL under exactly the path it claimed", async () => {
    // The Velay tunnel forwards the request path verbatim and the gateway
    // admits it only when it matches a claimed path byte for byte. A trailing
    // slash on this URL would be rejected before the gateway ever saw it.
    mockIsPlatform = true;
    const configSpy = spyOn(loader, "getConfig").mockReturnValue({
      ingress: { publicBaseUrl: "https://velay.vellum.ai/assistant-abc" },
    } as ReturnType<typeof loader.getConfig>);
    const spy = spyOn(registration, "resolveCallbackUrl").mockImplementation(
      async (directUrl) => directUrl(),
    );

    const url = await resolveWebhookUrl({
      plugin: "imessage",
      path: "events-photon",
    });

    const claimedPath = `/${spy.mock.calls[0]![1]}`;
    expect(claimedPath).toBe("/webhooks/plugins/imessage/events-photon");
    expect(new URL(url).pathname).toBe(`/assistant-abc${claimedPath}`);
    spy.mockRestore();
    configSpy.mockRestore();
  });

  test("keeps the trailing slash on a self-hosted ingress URL", async () => {
    // Off a pod the direct URL never rides the tunnel, so the spelling stays
    // what it always was.
    const configSpy = spyOn(loader, "getConfig").mockReturnValue({
      ingress: { publicBaseUrl: "https://assistant.example.test" },
    } as ReturnType<typeof loader.getConfig>);
    const spy = spyOn(registration, "resolveCallbackUrl").mockImplementation(
      async (directUrl) => directUrl(),
    );

    const url = await resolveWebhookUrl({
      plugin: "imessage",
      path: "events-photon",
    });

    expect(url).toBe(
      "https://assistant.example.test/webhooks/plugins/imessage/events-photon/",
    );
    spy.mockRestore();
    configSpy.mockRestore();
  });

  test("leaves a URL carrying a query string alone", async () => {
    // Appending there would cut into the query rather than the path.
    const spy = spyOn(registration, "resolveCallbackUrl").mockResolvedValue(
      "https://example.test/webhooks/plugins/imessage/events-comms?token=abc/",
    );

    await expect(
      resolveWebhookUrl({ plugin: "imessage", path: "events-comms" }),
    ).resolves.toBe(
      "https://example.test/webhooks/plugins/imessage/events-comms?token=abc/",
    );
    spy.mockRestore();
  });

  test("propagates the failure when nothing can answer", async () => {
    // No ingress and no platform connection means there is no URL that works.
    // Returning a plausible one would produce a vendor registration that
    // silently receives nothing.
    const spy = spyOn(registration, "resolveCallbackUrl").mockRejectedValue(
      new Error("Public ingress URL is not configured"),
    );

    await expect(
      resolveWebhookUrl({ plugin: "imessage", path: "events-photon" }),
    ).rejects.toThrow("Public ingress URL is not configured");
    spy.mockRestore();
  });
});
