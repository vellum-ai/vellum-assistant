import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, mock, test } from "bun:test";

import { waitFor } from "../__tests__/helpers/wait-for.js";
import { DESKTOP_APPS, DesktopAppManager } from "./desktop-apps.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "desktop-apps-test-"));
  directories.push(directory);
  let installed = false;
  let finish!: () => void;
  let fail!: () => void;
  const install = mock(
    () =>
      new Promise<void>((resolve, reject) => {
        finish = () => {
          installed = true;
          resolve();
        };
        fail = () => reject(new Error("download failed"));
      }),
  );
  const deps = {
    configDir: () => directory,
    installed: () => installed,
    install,
    notify: mock(async () => {}),
  };
  return {
    manager: new DesktopAppManager(deps),
    deps,
    directory,
    install,
    finish: () => finish(),
    fail: () => fail(),
    setInstalled: (value: boolean) => {
      installed = value;
    },
  };
}
test("listing is read-only, duplicate adds share an install, and restart rechecks the actual binary", async () => {
  const f = fixture();
  expect(f.manager.list()[0].state).toBe("available");
  expect(f.install).not.toHaveBeenCalled();
  f.manager.add(DESKTOP_APPS[0]);
  f.manager.add(DESKTOP_APPS[0]);
  expect(f.manager.list()[0].state).toBe("installing");
  await waitFor(() => f.install.mock.calls.length === 1);
  f.finish();
  await waitFor(() => f.manager.list()[0].state === "added");
  expect(
    readFileSync(join(f.directory, "applications/xcalc.desktop"), "utf8"),
  ).toContain("StartupWMClass=XCalc");
  expect(new DesktopAppManager(f.deps).list()[0].state).toBe("added");
  f.setInstalled(false);
  expect(new DesktopAppManager(f.deps).list()[0].state).toBe("available");
});
test("adding an installed app skips packages and preserves custom launchers", async () => {
  const f = fixture();
  f.setInstalled(true);
  expect(f.manager.list()[0].state).toBe("installed");
  f.manager.add(DESKTOP_APPS[0]);
  await waitFor(() => f.manager.list()[0].state === "added");
  const launcher = join(f.directory, "applications/xcalc.desktop");
  writeFileSync(launcher, "custom launcher");
  f.manager.add(DESKTOP_APPS[0]);
  await waitFor(() => f.manager.list()[0].state === "added");
  expect(f.install).not.toHaveBeenCalled();
  expect(readFileSync(launcher, "utf8")).toBe("custom launcher");
});
test("failed installs can retry and publish their final state", async () => {
  const f = fixture();
  f.manager.add(DESKTOP_APPS[0]);
  await waitFor(() => f.install.mock.calls.length === 1);
  f.fail();
  await waitFor(() => f.manager.list()[0].state === "failed");
  f.manager.add(DESKTOP_APPS[0]);
  await waitFor(() => f.install.mock.calls.length === 2);
  f.finish();
  await waitFor(() => f.manager.list()[0].state === "added");
  expect(f.deps.notify).toHaveBeenCalledTimes(4);
});
