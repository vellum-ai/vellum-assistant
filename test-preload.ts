/**
 * Root-level test preload — prevents accidental `bun test` from the repo root.
 *
 * Each package (assistant/, gateway/, cli/) has its own test configuration
 * including isolation preloads that redirect state directories to temp dirs.
 * Running `bun test` from the repo root skips those package-level preloads,
 * which can cause tests to read/write production data (databases, credentials,
 * contacts, etc.).
 *
 * This preload is registered in the root bunfig.toml. It checks whether the
 * current working directory is the repo root (by looking for this file) and
 * only throws in that case. Bun may still continue running sibling test files
 * after reporting a preload error, so the root case first redirects persistent
 * state to a temp workspace/security dir before throwing. Sub-packages without
 * their own bunfig.toml (e.g. cli/, packages/*) may inherit this preload but
 * will pass through safely since their cwd differs from the repo root.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";

const isRepoRoot = existsSync(join(process.cwd(), "test-preload.ts"));

if (isRepoRoot) {
  const testRoot = realpathSync(
    mkdtempSync(join(tmpdir(), "vellum-root-test-")),
  );
  const workspaceDir = join(testRoot, "workspace");
  const gatewaySecurityDir = join(testRoot, "gateway-security");

  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(gatewaySecurityDir, { recursive: true });

  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  process.env.GATEWAY_SECURITY_DIR = gatewaySecurityDir;
  delete process.env.CES_CREDENTIAL_URL;
  delete process.env.CES_SERVICE_TOKEN;

  afterAll(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  throw new Error(
    [
      "Do not run `bun test` from the repo root.",
      "Each package has its own test isolation preload that protects production state.",
      "Run tests from the correct package directory instead:",
      "",
      "  cd assistant && bun test src/path/to/file.test.ts",
      "  cd gateway   && bun test src/path/to/file.test.ts",
      "  cd cli       && bun test src/path/to/file.test.ts",
    ].join("\n"),
  );
}
