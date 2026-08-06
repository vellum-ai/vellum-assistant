import {
  resolveCliLauncherPaths,
  uninstallCliLauncher,
} from "../src/main/cli-path-installer";

const localAppData = process.env.LOCALAPPDATA;
if (localAppData) {
  uninstallCliLauncher(resolveCliLauncherPaths(localAppData));
}
