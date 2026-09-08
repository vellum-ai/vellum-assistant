import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { readSetting } from "./xcconfig-fixtures";

const APP_DIR = join(import.meta.dir, "../../App/App");

const PAIRS = [
  { app: "App.xcconfig", nse: "NotificationService.xcconfig" },
  { app: "App-Staging.xcconfig", nse: "NotificationService-Staging.xcconfig" },
  { app: "App-Dev.xcconfig", nse: "NotificationService-Dev.xcconfig" },
] as const;

describe("NotificationService xcconfigs stay prefixed by their host app", () => {
  for (const { app, nse } of PAIRS) {
    test(`${nse} bundle id and App Group match ${app}`, () => {
      const appId = readSetting(app, "PRODUCT_BUNDLE_IDENTIFIER");
      expect(readSetting(nse, "PRODUCT_BUNDLE_IDENTIFIER")).toBe(
        `${appId}.NotificationService`,
      );
      expect(readSetting(nse, "APP_GROUP_ID")).toBe(
        readSetting(app, "APP_GROUP_ID"),
      );
    });
  }
});

describe("Communication Notifications is declared on both sides", () => {
  // App and App Staging sign against App.entitlements, App Dev against
  // App-Dev.entitlements, so the pair covers all three app targets. Without the
  // entitlement `UNNotificationContent.updating(from:)` silently returns the
  // unmodified content.
  for (const file of ["App.entitlements", "App-Dev.entitlements"]) {
    test(`${file} carries the communication entitlement`, () => {
      expect(readFileSync(join(APP_DIR, file), "utf8")).toContain(
        "<key>com.apple.developer.usernotifications.communication</key>",
      );
    });
  }

  // App Store validation rejects the upload with ITMS-90894 when the
  // entitlement is present and NSUserActivityTypes omits the intent.
  test("the app Info.plist lists INSendMessageIntent", () => {
    const plist = readFileSync(join(APP_DIR, "Info.plist"), "utf8");
    expect(plist).toContain("<key>NSUserActivityTypes</key>");
    expect(plist).toContain("<string>INSendMessageIntent</string>");
  });
});

describe("NSE profile names agree with release-ios.yaml", () => {
  // Three places have to hold the same string character for character: the
  // Apple Developer portal, the xcconfig, and the workflow. The portal cannot
  // be checked from here, but a drift between the other two fails the archive
  // with "No profile for team ... matching '<name>' found", which names
  // neither file.
  const workflow = readFileSync(
    join(import.meta.dir, "../../../../.github/workflows/release-ios.yaml"),
    "utf8",
  );
  const workflowNames = workflow
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/nse_profile_name=(.+?)"/);
      return match ? [match[1]] : [];
    })
    .sort();

  test("the workflow names one profile per environment", () => {
    expect(workflowNames).toHaveLength(PAIRS.length);
  });

  test("every xcconfig specifier appears in the workflow", () => {
    const configNames = PAIRS.map(({ nse }) =>
      readSetting(nse, "PROVISIONING_PROFILE_SPECIFIER_Manual"),
    ).sort();
    expect(configNames).toEqual(workflowNames);
  });
});
