import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export function writeDesktopChromePolicy(policyDir: string): void {
  const path = join(policyDir, "vellum-desktop.json");
  let policy: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Desktop Chrome policy must be a JSON object");
    }
    policy = value as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  if (policy.CommandLineFlagSecurityWarningsEnabled === false) {
    return;
  }

  // This suppresses command-line warnings; Chrome's sandbox stays unchanged.
  policy.CommandLineFlagSecurityWarningsEnabled = false;
  mkdirSync(policyDir, { recursive: true });
  const staging = mkdtempSync(join(policyDir, ".vellum-desktop-"));
  try {
    const temporaryPath = join(staging, "policy.json");
    writeFileSync(temporaryPath, JSON.stringify(policy, null, 2) + "\n", {
      mode: 0o644,
    });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
