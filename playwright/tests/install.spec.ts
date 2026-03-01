/**
 * Smoke test for the recommended install.sh script.
 *
 * Runs the install script (with the final `vellum hatch` stripped out) and
 * then validates that `vellum ps` executes successfully. This is a
 * lightweight, non-agent test that exercises the CLI install path rather
 * than the desktop application.
 */

import { execSync } from "child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { test, expect } from "@playwright/test";

const INSTALL_SCRIPT = path.resolve(
  __dirname,
  "../../cli/src/adapters/install.sh",
);

test("install.sh installs vellum CLI and vellum ps works", async () => {
  // GIVEN the recommended install.sh script with the `vellum hatch` step
  // stripped out so we only test the install portion
  const original = readFileSync(INSTALL_SCRIPT, "utf-8");
  const modified = original.replace(
    /    info "Running vellum hatch\.\.\."[\s\S]*?\n}/m,
    "}",
  );

  const tmpDir = mkdtempSync(path.join(tmpdir(), "vellum-install-test-"));
  const modifiedScript = path.join(tmpDir, "install.sh");
  writeFileSync(modifiedScript, modified, { mode: 0o755 });

  // WHEN we run the install script
  execSync(`bash "${modifiedScript}"`, {
    stdio: "inherit",
    timeout: 120_000,
    env: {
      ...process.env,
      HOME: process.env.HOME ?? "/root",
    },
  });

  const bunBin = path.join(process.env.HOME ?? "/root", ".bun", "bin");
  const envWithBun = {
    ...process.env,
    PATH: `${bunBin}:${process.env.PATH}`,
  };

  // THEN `vellum ps` should run successfully and report no assistants
  const psOutput = execSync("vellum ps", {
    encoding: "utf-8",
    timeout: 30_000,
    env: envWithBun,
  });

  expect(psOutput).toContain("No assistants found");
});
