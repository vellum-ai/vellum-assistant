import { describe, expect, test } from "bun:test";

import { readSetting } from "./xcconfig-fixtures";

const PAIRS = [
  { app: "App.xcconfig", share: "Share.xcconfig" },
  { app: "App-Staging.xcconfig", share: "Share-Staging.xcconfig" },
  { app: "App-Dev.xcconfig", share: "Share-Dev.xcconfig" },
] as const;

describe("Share extension xcconfigs stay prefixed by their host app", () => {
  for (const { app, share } of PAIRS) {
    test(`${share} bundle id, App Group, and URL scheme match ${app}`, () => {
      const appId = readSetting(app, "PRODUCT_BUNDLE_IDENTIFIER");
      const shareId = readSetting(share, "PRODUCT_BUNDLE_IDENTIFIER");
      expect(shareId).toBe(`${appId}.Share`);
      expect(readSetting(share, "APP_GROUP_ID")).toBe(
        readSetting(app, "APP_GROUP_ID"),
      );
      expect(readSetting(share, "BUNDLE_URL_SCHEME")).toBe(
        readSetting(app, "BUNDLE_URL_SCHEME"),
      );
    });
  }
});
