/**
 * Reading the publish target off a publish/status response.
 *
 * The fallbacks carry the compatibility rule: an assistant older than
 * pluggable publish providers omits both fields and only ever had Vercel, so
 * an omission has to read as Vercel rather than as "unknown target".
 */

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_PUBLISH_PROVIDER_NAME,
  isVercelPublishProvider,
  publishProviderName,
} from "@/utils/publish-provider";

describe("publishProviderName", () => {
  test("uses the name the response carries", () => {
    expect(
      publishProviderName({ provider: "webhook", providerName: "Coolify" }),
    ).toBe("Coolify");
  });

  test("falls back for a response that names no provider", () => {
    expect(publishProviderName({})).toBe(DEFAULT_PUBLISH_PROVIDER_NAME);
    expect(publishProviderName(undefined)).toBe(DEFAULT_PUBLISH_PROVIDER_NAME);
    expect(publishProviderName({ providerName: "" })).toBe(
      DEFAULT_PUBLISH_PROVIDER_NAME,
    );
  });
});

describe("isVercelPublishProvider", () => {
  test("is true for Vercel and for a response that names no provider", () => {
    expect(isVercelPublishProvider({ provider: "vercel" })).toBe(true);
    expect(isVercelPublishProvider({})).toBe(true);
    expect(isVercelPublishProvider(undefined)).toBe(true);
  });

  test("is false for any other provider", () => {
    expect(isVercelPublishProvider({ provider: "webhook" })).toBe(false);
  });
});
