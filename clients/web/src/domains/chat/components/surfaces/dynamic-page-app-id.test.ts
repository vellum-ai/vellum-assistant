import { describe, expect, test } from "bun:test";

import type { Surface } from "@/domains/chat/types/types";
import { getDynamicPageAppId } from "@/domains/chat/components/surfaces/dynamic-page-app-id";

function surface(data: Record<string, unknown>): Surface {
  return {
    surfaceId: "surface-123",
    surfaceType: "dynamic_page",
    data,
  };
}

describe("getDynamicPageAppId", () => {
  test("returns the app id from dynamic page data", () => {
    expect(getDynamicPageAppId(surface({ appId: "app-123" }))).toBe("app-123");
  });

  test("returns the app id from snake_case dynamic page data", () => {
    expect(getDynamicPageAppId(surface({ app_id: "app-123" }))).toBe("app-123");
  });

  test("prefers camelCase app id over snake_case app id", () => {
    expect(getDynamicPageAppId(surface({ appId: "app-123", app_id: "app-456" }))).toBe("app-123");
  });

  test("trims surrounding whitespace", () => {
    expect(getDynamicPageAppId(surface({ appId: "  app-123  " }))).toBe("app-123");
  });

  test("falls back to snake_case app id when camelCase app id is blank", () => {
    expect(getDynamicPageAppId(surface({ appId: "  ", app_id: "app-123" }))).toBe("app-123");
  });

  test("returns null when no app id is present", () => {
    expect(getDynamicPageAppId(surface({}))).toBeNull();
  });

  test("does not fall back to the surface id", () => {
    expect(getDynamicPageAppId(surface({ preview: { title: "Calculator" } }))).toBeNull();
  });

  test("returns null for non-string or empty app ids", () => {
    expect(getDynamicPageAppId(surface({ appId: 123 }))).toBeNull();
    expect(getDynamicPageAppId(surface({ appId: "   " }))).toBeNull();
    expect(getDynamicPageAppId(surface({ app_id: 123 }))).toBeNull();
    expect(getDynamicPageAppId(surface({ app_id: "   " }))).toBeNull();
  });
});
