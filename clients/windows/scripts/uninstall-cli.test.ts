import { expect, mock, test } from "bun:test";
import path from "node:path";

import { resolveCliLauncherPaths } from "../src/main/cli-path-installer";
import { uninstallPackagedCli } from "./uninstall-cli";

const EXEC_PATH = path.join(
  "C:\\Program Files\\Vellum",
  "resources",
  "cli-runtime",
  "cli-uninstaller.exe",
);
const LOCAL_APP_DATA = "C:\\Users\\Example\\AppData\\Local";

test("fails when the command launcher cannot be removed", () => {
  const uninstallLauncher = mock(() => "blocked" as const);

  expect(() =>
    uninstallPackagedCli(EXEC_PATH, LOCAL_APP_DATA, uninstallLauncher),
  ).toThrow(
    "Unable to remove the Vellum command launcher. Close active vellum commands and try again.",
  );
  expect(uninstallLauncher).toHaveBeenCalledWith(
    resolveCliLauncherPaths(LOCAL_APP_DATA, "production"),
    undefined,
    path.dirname(path.dirname(EXEC_PATH)),
  );
});

test("continues when the command launcher is not owned", () => {
  const uninstallLauncher = mock(() => "not-owned" as const);

  expect(() =>
    uninstallPackagedCli(EXEC_PATH, LOCAL_APP_DATA, uninstallLauncher),
  ).not.toThrow();
});
