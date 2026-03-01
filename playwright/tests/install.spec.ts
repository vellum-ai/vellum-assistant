/**
 * Smoke test for the recommended install.sh script.
 *
 * Runs the install script (including `vellum hatch`) and then validates
 * that `vellum ps` reports the hatched assistant. Retires the assistant
 * at the end to clean up.
 */

import { execSync } from "child_process";
import path from "path";

import { test, expect } from "@playwright/test";

const INSTALL_SCRIPT = path.resolve(
  __dirname,
  "../../cli/src/adapters/install.sh",
);

test("install.sh installs vellum CLI and vellum ps works", async () => {
  const shellEnv = {
    ...process.env,
    HOME: process.env.HOME ?? "/root",
  };

  // GIVEN the recommended install.sh script
  // WHEN we run the install script (which includes vellum hatch)
  execSync(
    `bash "${INSTALL_SCRIPT}" && . ~/.config/vellum/env`,
    {
      stdio: "inherit",
      timeout: 300_000,
      shell: "/bin/bash",
      env: shellEnv,
    },
  );

  // THEN `vellum ps` should run successfully and report one assistant
  const psOutput = execSync(
    `vellum ps`,
    {
      encoding: "utf-8",
      timeout: 30_000,
      shell: "/bin/bash",
      env: shellEnv,
    },
  );

  expect(psOutput).toMatch(/NAME\s+STATUS\s+INFO/);

  // AND we retire the assistant to clean up
  const lines = psOutput
    .split("\n")
    .filter((l) => l.trim() && !l.includes("NAME") && !l.startsWith("  -"));
  const assistantName = lines[0]?.trim().split(/\s{2,}/)[0];

  if (assistantName) {
    execSync(
      `vellum retire ${assistantName}`,
      {
        stdio: "inherit",
        timeout: 30_000,
        shell: "/bin/bash",
        env: shellEnv,
      },
    );
  }
});
