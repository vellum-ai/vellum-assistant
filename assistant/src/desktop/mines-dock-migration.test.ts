import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { addMinesDockPinMigration } from "../workspace/migrations/155-add-mines-dock-pin.js";
import { runWorkspaceMigrations } from "../workspace/migrations/runner.js";
import { writeDesktopPanelConfig } from "./desktop-panel-config.js";

const workspaces: string[] = [];
afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function setup() {
  const workspace = mkdtempSync(join(tmpdir(), "mines-dock-upgrade-"));
  workspaces.push(workspace);
  const configDir = join(workspace, "data", "desktop-panel");
  const settingsDir = join(configDir, "glib-2.0", "settings");
  const pinsDir = join(configDir, "plank", "dock1", "launchers");
  mkdirSync(settingsDir, { recursive: true });
  mkdirSync(pinsDir, { recursive: true });
  return {
    workspace,
    configDir,
    pinsDir,
    settingsPath: join(settingsDir, "keyfile"),
    request: {
      configDir,
      chromiumPath: "/opt/chrome/chrome",
      chromiumProfileDir: join(workspace, "data", "desktop-profile"),
      terminalPath: "/usr/bin/xterm",
    },
  };
}

test("upgrades an existing dock once, preserving custom pins and later removal", async () => {
  const f = setup();
  const settings = [
    "[net/launchpad/plank/docks/dock1]",
    "dock-items=['custom.dockitem', 'terminal.dockitem']",
    "icon-size=64",
    "theme='Custom'",
    "[unrelated]",
    "dock-items=['other.dockitem']",
    "",
  ].join("\n");
  writeFileSync(f.settingsPath, settings);
  writeFileSync(join(f.pinsDir, "custom.dockitem"), "custom pin");

  await addMinesDockPinMigration.run(f.workspace);
  await runWorkspaceMigrations(f.workspace, [addMinesDockPinMigration]);
  writeDesktopPanelConfig(f.request);
  expect(readFileSync(f.settingsPath, "utf8")).toBe(
    settings.replace(
      "'terminal.dockitem']",
      "'terminal.dockitem', 'mines.dockitem']",
    ),
  );
  const launcher = readFileSync(join(f.pinsDir, "mines.dockitem"), "utf8");
  expect(launcher).toContain("applications/org.gnome.Mines.desktop");
  expect(
    readFileSync(
      join(f.configDir, "applications", "org.gnome.Mines.desktop"),
      "utf8",
    ),
  ).toContain("Exec=/usr/games/gnome-mines");
  expect(readFileSync(join(f.pinsDir, "custom.dockitem"), "utf8")).toBe(
    "custom pin",
  );
  expect(existsSync(join(f.pinsDir, "chrome.dockitem"))).toBe(false);

  rmSync(join(f.pinsDir, "mines.dockitem"));
  writeFileSync(f.settingsPath, settings);
  await runWorkspaceMigrations(f.workspace, [addMinesDockPinMigration]);
  writeDesktopPanelConfig(f.request);
  expect(existsSync(join(f.pinsDir, "mines.dockitem"))).toBe(false);
  expect(readFileSync(f.settingsPath, "utf8")).toBe(settings);
});

test("resumes partial pin creation without replacing an existing pin", async () => {
  const f = setup();
  writeFileSync(
    f.settingsPath,
    "[net/launchpad/plank/docks/dock1]\ndock-items=[]\n",
  );
  writeFileSync(join(f.pinsDir, "mines.dockitem"), "custom mines launcher");
  await addMinesDockPinMigration.run(f.workspace);
  await addMinesDockPinMigration.run(f.workspace);
  expect(readFileSync(f.settingsPath, "utf8")).toBe(
    "[net/launchpad/plank/docks/dock1]\ndock-items=['mines.dockitem']\n",
  );
  expect(readFileSync(join(f.pinsDir, "mines.dockitem"), "utf8")).toBe(
    "custom mines launcher",
  );
});

test("leaves a workspace without desktop support untouched", async () => {
  const f = setup();
  rmSync(f.configDir, { recursive: true });
  await addMinesDockPinMigration.run(f.workspace);
  expect(existsSync(f.configDir)).toBe(false);
});
