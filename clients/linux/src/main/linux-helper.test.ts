import { afterEach, describe, expect, mock, test } from "bun:test";
import * as realFs from "node:fs";
import path from "node:path";

let existing = new Set<string>();

mock.module("node:fs", () => ({
  ...realFs,
  existsSync: (candidate: string) => existing.has(candidate),
}));
mock.module("electron", () => ({ app: { getAppPath: () => "/app" } }));
// electron-log needs a fuller electron runtime than this test provides.
mock.module("./logger", () => ({
  default: { info: () => undefined, warn: () => undefined },
}));

const { getLinuxHelperPath, resolveLinuxHelperPath } =
  await import("./linux-helper");

const tail = path.join("native-helper", process.arch, "vellum-linux-helper");
const packaged = path.join("/resources", tail);
const devPublish = path.join("/app", "resources", tail);

const withResourcesPath = (value: string | undefined): void => {
  const target = process as { resourcesPath?: string };
  if (value === undefined) {
    delete target.resourcesPath;
  } else {
    target.resourcesPath = value;
  }
};

afterEach(() => {
  existing = new Set();
  delete process.env["VELLUM_LINUX_HELPER_PATH"];
  withResourcesPath(undefined);
});

describe("resolveLinuxHelperPath", () => {
  test("prefers the override, then the packaged dir, then the dev dir", () => {
    withResourcesPath("/resources");
    process.env["VELLUM_LINUX_HELPER_PATH"] = "/opt/helper";
    existing = new Set(["/opt/helper", packaged, devPublish]);
    expect(resolveLinuxHelperPath()).toBe("/opt/helper");

    delete process.env["VELLUM_LINUX_HELPER_PATH"];
    expect(resolveLinuxHelperPath()).toBe(packaged);

    withResourcesPath(undefined);
    expect(resolveLinuxHelperPath()).toBe(devPublish);
  });

  test("fails closed when no helper is installed", () => {
    withResourcesPath("/resources");
    expect(resolveLinuxHelperPath()).toBeNull();
    // The supervisor throws on a missing executable, so RPCs reject instead of
    // spawning something unexpected.
    expect(getLinuxHelperPath()).toBe("/nonexistent/vellum-linux-helper");
    expect(realFs.existsSync(getLinuxHelperPath())).toBe(false);
  });
});
