import { afterEach, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { launchOwnedCli, resolveOwnedCliTarget } from "./launch-cli";

let tempDir = "";

const writeLauncher = (): { launcher: string; target: string } => {
  tempDir = mkdtempSync(path.join(tmpdir(), "vellum-cli-launcher-"));
  const binDir = path.join(tempDir, "bin");
  const runtimeDir = path.join(tempDir, "runtime");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  const launcher = path.join(binDir, "vellum.exe");
  const target = path.join(runtimeDir, "vellum.exe");
  writeFileSync(launcher, "launcher", "utf8");
  writeFileSync(target, "runtime", "utf8");
  writeFileSync(
    path.join(binDir, ".vellum-owned.json"),
    JSON.stringify({ sourcePath: target }),
    "utf8",
  );
  return { launcher, target };
};

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

test("forwards CLI arguments to the owned versioned runtime", () => {
  const { launcher, target } = writeLauncher();
  const spawnCli = mock(() => ({ status: 17 }));

  expect(launchOwnedCli(launcher, ["ps", "--json"], spawnCli)).toBe(17);
  expect(spawnCli).toHaveBeenCalledWith(target, ["ps", "--json"], {
    stdio: "inherit",
    windowsHide: false,
  });
});

test("rejects a launcher that points back to itself", () => {
  const { launcher } = writeLauncher();
  writeFileSync(
    path.join(path.dirname(launcher), ".vellum-owned.json"),
    JSON.stringify({ sourcePath: launcher }),
    "utf8",
  );

  expect(() => resolveOwnedCliTarget(launcher)).toThrow(
    "installed Vellum CLI runtime is unavailable",
  );
});

test("rejects a case-variant launcher path that points back to itself", () => {
  const { launcher } = writeLauncher();
  writeFileSync(
    path.join(path.dirname(launcher), ".vellum-owned.json"),
    JSON.stringify({ sourcePath: launcher.toUpperCase() }),
    "utf8",
  );

  expect(() => resolveOwnedCliTarget(launcher)).toThrow(
    "installed Vellum CLI runtime is unavailable",
  );
});
