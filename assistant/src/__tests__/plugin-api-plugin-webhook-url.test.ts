/**
 * `resolvePluginWebhookUrl` — the URL a plugin hands a vendor.
 *
 * The interesting cases are the ones a plugin would get wrong on its own:
 * which tier wins, and what happens when none of them can answer. The
 * resolution itself lives in `resolveCallbackUrl`, which is spied on here
 * rather than reimplemented — the point of this module is that plugins stop
 * carrying a second copy of that order, so a test that restated it would
 * defeat the exercise.
 */

import { describe, expect, spyOn, test } from "bun:test";

import * as registration from "../inbound/platform-callback-registration.js";
import { resolvePluginWebhookUrl } from "../plugin-api/plugin-webhook-url.js";

describe("resolvePluginWebhookUrl", () => {
  test("composes the plugin's namespaced path and delegates the tier choice", async () => {
    const spy = spyOn(registration, "resolveCallbackUrl").mockResolvedValue(
      "https://callbacks.vellum.ai/abc/webhooks/plugins/imessage/events-photon",
    );

    const url = await resolvePluginWebhookUrl({
      plugin: "imessage",
      path: "events-photon",
    });

    expect(url).toBe(
      "https://callbacks.vellum.ai/abc/webhooks/plugins/imessage/events-photon",
    );
    const [, callbackPath, type] = spy.mock.calls[0]!;
    expect(callbackPath).toBe("webhooks/plugins/imessage/events-photon");
    // Per route, not per plugin: a plugin declares several, and a shared type
    // would have each registration overwrite the last.
    expect(type).toBe("plugin_imessage_events_photon");
    spy.mockRestore();
  });

  test("gives each declared route its own registration type", async () => {
    const spy = spyOn(registration, "resolveCallbackUrl").mockResolvedValue(
      "https://example.test/x",
    );

    await resolvePluginWebhookUrl({ plugin: "imessage", path: "events-comms" });
    await resolvePluginWebhookUrl({
      plugin: "imessage",
      path: "events-photon",
    });

    const types = spy.mock.calls.map((call) => call[2]);
    expect(new Set(types).size).toBe(2);
    spy.mockRestore();
  });

  test("refuses a plugin name or path that is not a safe URL segment", async () => {
    // The prefix is fixed here so a plugin cannot claim another's namespace;
    // that only holds if the segments cannot escape it either.
    for (const options of [
      { plugin: "../vellum", path: "events" },
      { plugin: "imessage", path: "../../admin" },
      { plugin: "imessage", path: "" },
      { plugin: "imessage", path: "/" },
    ]) {
      await expect(resolvePluginWebhookUrl(options)).rejects.toThrow(/Invalid/);
    }
  });

  test("strips a leading slash rather than doubling it", async () => {
    const spy = spyOn(registration, "resolveCallbackUrl").mockResolvedValue(
      "https://example.test/x",
    );

    await resolvePluginWebhookUrl({ plugin: "imessage", path: "/events" });

    expect(spy.mock.calls[0]![1]).toBe("webhooks/plugins/imessage/events");
    spy.mockRestore();
  });

  test("propagates the failure when nothing can answer", async () => {
    // No ingress and no platform connection means there is no URL that would
    // work. Returning a plausible one would produce a vendor registration that
    // silently receives nothing.
    const spy = spyOn(registration, "resolveCallbackUrl").mockRejectedValue(
      new Error("Public ingress URL is not configured"),
    );

    await expect(
      resolvePluginWebhookUrl({ plugin: "imessage", path: "events-photon" }),
    ).rejects.toThrow("Public ingress URL is not configured");
    spy.mockRestore();
  });
});
