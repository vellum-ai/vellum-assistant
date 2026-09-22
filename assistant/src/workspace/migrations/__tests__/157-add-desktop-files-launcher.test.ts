import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { writeDesktopPanelConfig } from "../../../desktop/desktop-panel-config.js";
import { WORKSPACE_MIGRATIONS } from "../registry.js";

const migration = WORKSPACE_MIGRATIONS.find(
  (entry) => entry.id === "157-add-desktop-files-launcher",
)!;

const workspaces: string[] = [];
afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function setup() {
  const workspace = mkdtempSync(join(tmpdir(), "desktop-files-migration-"));
  workspaces.push(workspace);
  const configDir = join(workspace, "data", "desktop-panel");
  const settingsPath = join(configDir, "glib-2.0", "settings", "keyfile");
  return { workspace, configDir, settingsPath };
}

test("upgrades a customized dock idempotently and respects later unpinning", () => {
  const { workspace, configDir, settingsPath } = setup();
  mkdirSync(dirname(settingsPath), { recursive: true });
  const original =
    "[unrelated]\nvalue=keep\n\n[net/launchpad/plank/docks/dock1]\ndock-items=['chrome.dockitem', 'terminal.dockitem', 'custom.dockitem']\nicon-size=64\n\n[another]\ndock-items=['other.dockitem']\n";
  writeFileSync(settingsPath, original);
  migration.run(workspace);
  const upgraded = readFileSync(settingsPath, "utf8");
  expect(upgraded).toBe(
    original.replace(
      "'chrome.dockitem', 'terminal.dockitem'",
      "'chrome.dockitem', 'files.dockitem', 'terminal.dockitem'",
    ),
  );
  migration.run(workspace);
  expect(readFileSync(settingsPath, "utf8")).toBe(upgraded);
  const pin = join(configDir, "plank", "dock1", "launchers", "files.dockitem");
  expect(readFileSync(pin, "utf8")).toContain("/applications/thunar.desktop");
  rmSync(pin);
  writeFileSync(settingsPath, original);
  writeDesktopPanelConfig({
    configDir,
    chromiumPath: "/opt/chrome/chrome",
    chromiumProfileDir: join(workspace, "profile"),
    terminalPath: "/usr/bin/wezterm",
    fileManagerPath: "/usr/bin/thunar",
    workspaceDir: workspace,
  });
  expect(existsSync(pin)).toBe(false);
  expect(readFileSync(settingsPath, "utf8")).toBe(original);
  expect(existsSync(join(configDir, "applications", "thunar.desktop"))).toBe(
    true,
  );
});

test.each(["[]", "@as []"])(
  "upgrades an empty dock (%s) and recovers an existing pin",
  (items) => {
    const { workspace, configDir, settingsPath } = setup();
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      `[net/launchpad/plank/docks/dock1]\ndock-items=${items}\n`,
    );
    const pin = join(
      configDir,
      "plank",
      "dock1",
      "launchers",
      "files.dockitem",
    );
    mkdirSync(dirname(pin), { recursive: true });
    writeFileSync(pin, "user launcher");
    migration.run(workspace);
    expect(readFileSync(settingsPath, "utf8")).toContain(
      "dock-items=['files.dockitem']",
    );
    expect(readFileSync(pin, "utf8")).toBe("user launcher");
  },
);

test("does not initialize a desktop for workspaces without one", () => {
  const { workspace, configDir } = setup();
  migration.run(workspace);
  expect(existsSync(configDir)).toBe(false);
});

test("adds an implicit dock pin list inside the correct settings section", () => {
  const { workspace, settingsPath } = setup();
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(
    settingsPath,
    "[unrelated]\nvalue=keep\n[net/launchpad/plank/docks/dock1]\nicon-size=64\n[next]\nvalue=also-keep\n",
  );
  migration.run(workspace);
  expect(readFileSync(settingsPath, "utf8")).toBe(
    "[unrelated]\nvalue=keep\n[net/launchpad/plank/docks/dock1]\nicon-size=64\ndock-items=['files.dockitem']\n\n[next]\nvalue=also-keep\n",
  );
});
