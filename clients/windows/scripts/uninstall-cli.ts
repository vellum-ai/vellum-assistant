import path from "node:path";

import {
  resolveCliLauncherPaths,
  uninstallCliLauncher,
} from "../src/main/cli-path-installer";

const localAppData = process.env.LOCALAPPDATA;
if (localAppData) {
  uninstallCliLauncher(
    resolveCliLauncherPaths(localAppData),
    undefined,
    path.dirname(path.dirname(process.execPath)),
  );
}
