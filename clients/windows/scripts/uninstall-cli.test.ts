import { expect, mock, test } from "bun:test";
import path from "node:path";

import { resolveCliLauncherPaths } from "../src/main/cli-path-installer";
import { uninstallPackagedCli } from "./uninstall-cli";

test("fails when the command launcher cannot be removed", () => {
  const execPath = path.join(
    "C:\\Program Files\\Vellum",
    "resources",
    "cli-runtime",
    "cli-uninstaller.exe",
  );
  const localAppData = "C:\\Users\\Example\\AppData\\Local";
  const uninstallLauncher = mock(() => false);

  expect(() =>
    uninstallPackagedCli(execPath, localAppData, uninstallLauncher),
  ).toThrow(
    "Unable to remove the Vellum command launcher. Close active vellum commands and try again.",
  );
  expect(uninstallLauncher).toHaveBeenCalledWith(
    resolveCliLauncherPaths(localAppData, "production"),
    undefined,
    path.dirname(path.dirname(execPath)),
  );
});
