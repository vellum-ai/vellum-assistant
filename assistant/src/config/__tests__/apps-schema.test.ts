/**
 * Guards over the `apps.publish` config block.
 *
 * Two contracts: a workspace that configures nothing publishes to Vercel, and
 * nothing a user can write into the block can fail the whole config load.
 */

import { describe, expect, test } from "bun:test";

import { AssistantConfigSchema } from "../schema.js";
import { AppsConfigSchema } from "../schemas/apps.js";

describe("apps config schema", () => {
  test("defaults to Vercel with an unconfigured webhook", () => {
    expect(AppsConfigSchema.parse({})).toEqual({
      publish: {
        provider: "vercel",
        webhook: {
          url: "",
          unpublishUrl: "",
          unpublishMethod: "DELETE",
          timeoutMs: 60_000,
        },
      },
    });
  });

  test("the assistant config defaults to the same block", () => {
    expect(AssistantConfigSchema.parse({}).apps.publish.provider).toBe(
      "vercel",
    );
  });

  test("selects the webhook provider", () => {
    expect(
      AppsConfigSchema.parse({ publish: { provider: "webhook" } }),
    ).toMatchObject({ publish: { provider: "webhook" } });
  });

  test("an unknown provider id falls back rather than failing the load", () => {
    expect(
      AppsConfigSchema.parse({ publish: { provider: "coolify" } }).publish
        .provider,
    ).toBe("vercel");
  });

  test("wrong-typed webhook leaves fall back to their defaults", () => {
    expect(
      AppsConfigSchema.parse({
        publish: {
          provider: 7,
          webhook: { url: 3, unpublishMethod: "PUT", timeoutMs: "soon" },
        },
      }),
    ).toEqual({
      publish: {
        provider: "vercel",
        webhook: {
          url: "",
          unpublishUrl: "",
          unpublishMethod: "DELETE",
          timeoutMs: 60_000,
        },
      },
    });
  });

  test("an out-of-range timeout falls back to the default", () => {
    expect(
      AppsConfigSchema.parse({ publish: { webhook: { timeoutMs: 1 } } }).publish
        .webhook.timeoutMs,
    ).toBe(60_000);
  });

  test("the url is kept verbatim; its shape is checked where it is used", () => {
    expect(
      AppsConfigSchema.parse({
        publish: { webhook: { url: "https://deploy.example.com/publish" } },
      }).publish.webhook.url,
    ).toBe("https://deploy.example.com/publish");
  });
});
