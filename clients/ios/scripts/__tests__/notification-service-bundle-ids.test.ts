import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { readSetting } from "./xcconfig-fixtures";

const APP_DIR = join(import.meta.dir, "../../App/App");
const NSE_DIR = join(import.meta.dir, "../../App/NotificationService");
const REPO_ROOT = join(import.meta.dir, "../../../..");

const RELEASE_WORKFLOW = readFileSync(
  join(REPO_ROOT, ".github/workflows/release-ios.yaml"),
  "utf8",
);

function workflowOutputs(key: string): string[] {
  return RELEASE_WORKFLOW.split("\n")
    .flatMap((line) => {
      const match = line.match(new RegExp(`${key}=(.+?)"`));
      return match ? [match[1]] : [];
    })
    .sort();
}

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
  // entitlement `UNNotificationContent.updating(from:)` either throws or
  // returns the unmodified content, so the banner loses its avatar with or
  // without a log line to explain it.
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

  // `IntentsSupported` belongs to the Intents extension point, not to
  // `com.apple.usernotifications.service`. The app's NSUserActivityTypes above
  // is what declares the intent; claiming it here again buys nothing and gives
  // the next reader a second, wrong place to look.
  test("the extension Info.plist declares no IntentsSupported", () => {
    expect(readFileSync(join(NSE_DIR, "Info.plist"), "utf8")).not.toContain(
      "IntentsSupported",
    );
  });
});

describe("NSE profile names agree with release-ios.yaml", () => {
  // Three places have to hold the same string character for character: the
  // Apple Developer portal, the xcconfig, and the workflow. The portal cannot
  // be checked from here, but a drift between the other two fails the archive
  // with "No profile for team ... matching '<name>' found", which names
  // neither file.
  const workflowNames = workflowOutputs("nse_profile_name");

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

describe("NSE bundle ids agree with release-ios.yaml", () => {
  // The workflow writes one ExportOptions.plist entry per signed bundle, and
  // `-exportArchive` fails on an entry that names a bundle the archive does
  // not contain, with an error that names neither.
  const workflowIds = workflowOutputs("nse_bundle_id");

  test("the workflow names one bundle id per environment", () => {
    expect(workflowIds).toHaveLength(PAIRS.length);
  });

  test("every xcconfig bundle id appears in the workflow", () => {
    const configIds = PAIRS.map(({ nse }) =>
      readSetting(nse, "PRODUCT_BUNDLE_IDENTIFIER"),
    ).sort();
    expect(configIds).toEqual(workflowIds);
  });
});

describe("App Group ids agree with release-ios.yaml", () => {
  // The workflow asserts each installed profile grants this environment's group
  // by name, so a drift between it and the xcconfigs would either reject a
  // correct profile or accept one issued against another environment's App ID.
  const workflowGroups = workflowOutputs("app_group");

  test("the workflow names one App Group per environment", () => {
    expect(workflowGroups).toHaveLength(PAIRS.length);
  });

  test("every xcconfig App Group appears in the workflow", () => {
    const configGroups = PAIRS.map(({ app }) =>
      readSetting(app, "APP_GROUP_ID"),
    ).sort();
    expect(configGroups).toEqual(workflowGroups);
  });
});

describe("every avatar failure token is documented", () => {
  // The README's `reason=` table is the only place a `nse.avatar_unavailable`
  // line can be decoded, so a token that reaches Console without a row there
  // is a dead end for whoever is holding the device.
  const source = readFileSync(join(NSE_DIR, "AvatarCache.swift"), "utf8");
  const body = source.split("enum UnavailableReason")[1] ?? "";
  const tokens = [...body.split("}")[0].matchAll(/case \w+ = "(\w+)"/g)].map(
    (match) => match[1],
  );
  const readme = readFileSync(join(import.meta.dir, "../../README.md"), "utf8");

  test("the enum parses", () => {
    expect(tokens.length).toBeGreaterThan(0);
  });

  for (const token of tokens) {
    test(`${token} has a row in the README table`, () => {
      expect(readme).toContain(`| \`${token}\` |`);
    });
  }
});
