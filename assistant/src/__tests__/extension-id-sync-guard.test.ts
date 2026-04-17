/**
 * Guard tests for Chrome extension allowlist configuration.
 *
 * Single source of truth:
 *   meta/browser-extension/chrome-extension-allowlist.json
 *
 * This guard ensures:
 *   1) Canonical config has a valid shape and valid extension IDs.
 *   2) Assistant runtime allowlist mirrors canonical config.
 *   3) The concrete extension ID literal appears only in canonical config
 *      (not duplicated across runtime/tests/docs).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { ALLOWED_EXTENSION_ORIGINS } from "../runtime/routes/browser-extension-pair-routes.js";

const repoRoot = resolve(__dirname, "..", "..", "..");
const CANONICAL_CONFIG_REL_PATH =
  "meta/browser-extension/chrome-extension-allowlist.json";
const CANONICAL_CONFIG_ABS_PATH = join(repoRoot, CANONICAL_CONFIG_REL_PATH);
const LOCAL_OVERRIDE_PATH = join(
  homedir(),
  ".vellum",
  "chrome-extension-allowlist.local.json",
);

const EXTENSION_ID_REGEX = /^[a-p]{32}$/;
const PLACEHOLDER_ID_REGEX = /^TODO_[A-Z0-9_]+$/;

type AllowlistConfig = {
  version: number;
  allowedExtensionIds: string[];
};

function parseCanonicalConfig(): AllowlistConfig {
  const raw = readFileSync(CANONICAL_CONFIG_ABS_PATH, "utf8");
  const parsed = JSON.parse(raw) as Partial<AllowlistConfig>;

  if (!Number.isInteger(parsed.version) || (parsed.version ?? 0) <= 0) {
    throw new Error(
      "Invalid canonical config: version must be a positive integer",
    );
  }

  if (!Array.isArray(parsed.allowedExtensionIds)) {
    throw new Error(
      "Invalid canonical config: allowedExtensionIds must be an array",
    );
  }

  if (parsed.allowedExtensionIds.length === 0) {
    throw new Error(
      "Invalid canonical config: allowedExtensionIds must contain at least one id",
    );
  }

  const seen = new Set<string>();
  const validIds: string[] = [];
  for (const id of parsed.allowedExtensionIds) {
    if (typeof id !== "string") {
      throw new Error(`Invalid canonical extension id: ${String(id)}`);
    }
    if (seen.has(id)) {
      throw new Error(`Duplicate canonical extension id: ${id}`);
    }
    seen.add(id);

    if (EXTENSION_ID_REGEX.test(id)) {
      validIds.push(id);
    } else if (!PLACEHOLDER_ID_REGEX.test(id)) {
      throw new Error(`Invalid canonical extension id: ${id}`);
    }
  }

  if (validIds.length === 0) {
    throw new Error(
      "Invalid canonical config: allowedExtensionIds must contain at least one real extension id",
    );
  }

  return {
    version: parsed.version as number,
    allowedExtensionIds: validIds,
  };
}

function listTextFilesRecursively(root: string): string[] {
  const ignoredDirs = new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next",
    ".turbo",
    ".idea",
    ".vscode",
    ".codex-worktrees",
  ]);

  const allowedExtensions = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
    ".md",
    ".swift",
    ".sh",
    ".toml",
    ".yml",
    ".yaml",
    ".txt",
  ]);

  const out: string[] = [];

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // Directory may have been removed by a concurrent test; skip it.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".DS_Store")) continue;
      // Skip temp fixtures created by parallel tests (e.g. .test-starter-bundle-<pid>).
      if (entry.name.startsWith(".test-")) continue;
      const absPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name)) continue;
        walk(absPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = entry.name.slice(entry.name.lastIndexOf("."));
      if (!allowedExtensions.has(ext)) continue;

      // Skip large files to keep this guard lightweight.
      let size: number;
      try {
        size = statSync(absPath).size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      if (size > 1_000_000) continue;
      out.push(absPath);
    }
  }

  walk(root);
  return out;
}

describe("Chrome extension allowlist guard", () => {
  test("canonical allowlist config is valid", () => {
    const config = parseCanonicalConfig();
    expect(config.version).toBeGreaterThan(0);
    expect(config.allowedExtensionIds.length).toBeGreaterThan(0);
  });

  test("assistant runtime allowlist contains every canonical origin", () => {
    // The runtime set is the union of canonical + local override
    // (~/.vellum/chrome-extension-allowlist.local.json) + env var. A dev
    // machine may have extras; we only assert the canonical IDs are present.
    const config = parseCanonicalConfig();
    for (const id of config.allowedExtensionIds) {
      const origin = `chrome-extension://${id}/`;
      expect(ALLOWED_EXTENSION_ORIGINS.has(origin)).toBe(true);
    }
  });

  test("assistant runtime allowlist exactly mirrors canonical when no override sources are active", () => {
    // Exact-equality invariant: when neither the local override file nor
    // the env-var override is active, the runtime set must equal the
    // canonical set — nothing extra, nothing missing. A dev machine with
    // an unpacked-extension override will skip this deterministic check
    // and rely on the subset assertion above.
    if (existsSync(LOCAL_OVERRIDE_PATH)) return;
    if (
      process.env.VELLUM_CHROME_EXTENSION_IDS ||
      process.env.VELLUM_CHROME_EXTENSION_ID
    ) {
      return;
    }

    const config = parseCanonicalConfig();
    const expectedOrigins = new Set(
      config.allowedExtensionIds.map((id) => `chrome-extension://${id}/`),
    );
    expect(new Set(ALLOWED_EXTENSION_ORIGINS)).toEqual(expectedOrigins);
  });

  test("concrete extension IDs appear only in canonical config or CWS URLs", () => {
    // The canonical extension ID may also appear in Chrome Web Store URLs
    // (e.g. chromewebstore.google.com/detail/.../ID) or in documentation
    // referencing the published extension. Those are acceptable — they
    // reference the published extension, not duplicate config. We flag
    // files where the ID appears outside of a CWS URL context.
    const config = parseCanonicalConfig();
    const allFiles = listTextFilesRecursively(repoRoot);

    const CWS_URL_PATTERN =
      /chromewebstore\.google\.com\/detail\/[^/]+\/[a-p]{32}/g;

    for (const extensionId of config.allowedExtensionIds) {
      const unexpectedMatches: string[] = [];
      for (const absPath of allFiles) {
        const relPath = absPath.replace(`${repoRoot}/`, "");
        let content: string;
        try {
          content = readFileSync(absPath, "utf8");
        } catch (err) {
          // File may have been removed by a concurrent test between listing and reading.
          if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw err;
        }
        if (!content.includes(extensionId)) continue;
        if (relPath === CANONICAL_CONFIG_REL_PATH) continue;

        // Strip all CWS URLs and check if the ID still appears — if it
        // does, the file is using the ID as a standalone config value.
        const stripped = content.replace(CWS_URL_PATTERN, "");
        if (stripped.includes(extensionId)) {
          unexpectedMatches.push(relPath);
        }
      }
      expect(unexpectedMatches).toEqual([]);
    }
  });
});
