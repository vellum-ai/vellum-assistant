import { expect, test } from "bun:test";

import { verifyDesktopBrowserParent } from "./desktop-native-host.js";

test("native bootstrap requires the managed executable, profile, and display", async () => {
  const expected = {
    chromePath: "/opt/example/chrome",
    profileDir: "/tmp/example/desktop-profile",
  };
  const browser = {
    executable: expected.chromePath,
    args: [`--user-data-dir=${expected.profileDir}`],
    parent: 1,
  };
  expect(
    await verifyDesktopBrowserParent(expected, ":99", async () => browser),
  ).toBe(true);
  expect(
    await verifyDesktopBrowserParent(expected, ":0", async () => browser),
  ).toBe(false);
  expect(
    await verifyDesktopBrowserParent(expected, ":99", async () => ({
      ...browser,
      args: ["--user-data-dir=/tmp/personal-profile"],
    })),
  ).toBe(false);
  expect(
    await verifyDesktopBrowserParent(expected, ":99", async () => ({
      ...browser,
      executable: "/opt/example/chromium",
    })),
  ).toBe(false);
  expect(
    await verifyDesktopBrowserParent(expected, ":99", async () => ({
      ...browser,
      args: [...browser.args, "--type=renderer"],
    })),
  ).toBe(false);
});
