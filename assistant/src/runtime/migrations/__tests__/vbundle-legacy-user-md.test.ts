/**
 * Tests for legacy `prompts/USER.md` translation during vbundle import.
 *
 * Covers:
 * - `DefaultPathResolver` translates `prompts/USER.md` to the current
 *   guardian's `users/<slug>.md` path when a guardian exists.
 * - Missing guardian → resolver returns null (commit skips with warn).
 * - Full commit round-trip: legacy bundle writes content into
 *   `users/<slug>.md` on a fresh workspace.
 * - Missing guardian: commit skips the legacy entry with a warning
 *   instead of crashing.
 * - Already-customized `users/<slug>.md` is NOT overwritten.
 * - Pristine scaffold `users/<slug>.md` (template only) IS overwritten.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { buildVBundle } from "../vbundle-builder.js";
import {
  analyzeImport,
  DefaultPathResolver,
} from "../vbundle-import-analyzer.js";
import { commitImport } from "../vbundle-importer.js";
import { defaultV1Options } from "./v1-test-helpers.js";

// ---------------------------------------------------------------------------
// Shared fixture: per-test workspace under VELLUM_WORKSPACE_DIR.
// ---------------------------------------------------------------------------

const WORKSPACE_ROOT = process.env.VELLUM_WORKSPACE_DIR!;
const USERS_DIR = join(WORKSPACE_ROOT, "users");

const LEGACY_USER_MD_CONTENT = `# User Profile

- Preferred name/reference: Captain Legacy
- Pronouns: they/them
- Work role: Archivist
- Hobbies/fun: Unearthing old bundles
`;

/**
 * Bare scaffold template matching `GUARDIAN_PERSONA_TEMPLATE` in
 * `persona-resolver.ts`. Duplicated here intentionally so the test
 * pins the exact bytes that count as "not customized".
 */
const PRISTINE_SCAFFOLD = `_ Lines starting with _ are comments - they won't appear in the system prompt

# User Profile

Store details about your user here. Edit freely - build this over time as you learn about them. Don't be pushy about seeking details, but when you learn something, write it down. More context makes you more useful.

- Preferred name/reference:
- Pronouns:
- Locale:
- Work role:
- Goals:
- Hobbies/fun:
- Daily tools:
`;

/**
 * Customized guardian persona file — has user-authored content past the
 * bare scaffold. Must survive an import unchanged.
 */
const CUSTOMIZED_PERSONA = `_ Lines starting with _ are comments - they won't appear in the system prompt

# User Profile

- Preferred name/reference: Real User
- Pronouns: she/her
- Locale: en-US
- Work role: Staff Engineer
- Goals: Ship drop-user-md
- Hobbies/fun: Reading papers
- Daily tools: Terminal, Vellum
`;

function cleanWorkspace() {
  try {
    rmSync(USERS_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  mkdirSync(USERS_DIR, { recursive: true });
}

beforeEach(() => {
  cleanWorkspace();
});

afterEach(() => {
  cleanWorkspace();
});

// ---------------------------------------------------------------------------
// DefaultPathResolver — USER.md translation
// ---------------------------------------------------------------------------

describe("DefaultPathResolver prompts/USER.md translation", () => {
  test("rewrites prompts/USER.md to the guardian's users/<slug>.md", () => {
    const guardianPath = join(USERS_DIR, "captain.md");
    const resolver = new DefaultPathResolver(
      WORKSPACE_ROOT,
      undefined,
      () => guardianPath,
    );

    expect(resolver.resolve("prompts/USER.md")).toBe(guardianPath);
  });

  test("returns null when no guardian exists", () => {
    const resolver = new DefaultPathResolver(
      WORKSPACE_ROOT,
      undefined,
      () => null,
    );

    expect(resolver.resolve("prompts/USER.md")).toBeNull();
  });

  test("rejects guardian paths outside the workspace (traversal guard)", () => {
    // Stubbed resolver returns a path outside the workspace — the
    // analyzer resolver must reject it to prevent writing outside
    // the workspace root.
    const resolver = new DefaultPathResolver(
      WORKSPACE_ROOT,
      undefined,
      () => "/etc/passwd",
    );

    expect(resolver.resolve("prompts/USER.md")).toBeNull();
  });

  test("still resolves other prompt files (IDENTITY.md) to workspace root", () => {
    const resolver = new DefaultPathResolver(WORKSPACE_ROOT, undefined, () =>
      join(USERS_DIR, "captain.md"),
    );

    expect(resolver.resolve("prompts/IDENTITY.md")).toBe(
      join(WORKSPACE_ROOT, "IDENTITY.md"),
    );
    expect(resolver.resolve("prompts/SOUL.md")).toBe(
      join(WORKSPACE_ROOT, "SOUL.md"),
    );
    expect(resolver.resolve("prompts/UPDATES.md")).toBe(
      join(WORKSPACE_ROOT, "UPDATES.md"),
    );
  });

  test("skips unknown prompt filenames regardless of guardian state", () => {
    const resolver = new DefaultPathResolver(WORKSPACE_ROOT, undefined, () =>
      join(USERS_DIR, "captain.md"),
    );

    expect(resolver.resolve("prompts/SECRET.md")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// analyzeImport — surfaces the translated destination for preflight
// ---------------------------------------------------------------------------

describe("analyzeImport for legacy prompts/USER.md", () => {
  test("reports a `create` action on a fresh users/<slug>.md", () => {
    const guardianPath = join(USERS_DIR, "captain.md");
    const resolver = new DefaultPathResolver(
      WORKSPACE_ROOT,
      undefined,
      () => guardianPath,
    );

    const { archive, manifest } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array(),
        },
        {
          path: "prompts/USER.md",
          data: new TextEncoder().encode(LEGACY_USER_MD_CONTENT),
        },
      ],
      ...defaultV1Options(),
    });
    expect(archive.length).toBeGreaterThan(0);

    const report = analyzeImport({ manifest, pathResolver: resolver });

    expect(report.can_import).toBe(true);
    const userMd = report.files.find((f) => f.path === "prompts/USER.md");
    expect(userMd).toBeDefined();
    expect(userMd!.action).toBe("create");
  });

  test("non-blocking skip when no guardian is resolvable (can_import stays true)", () => {
    const resolver = new DefaultPathResolver(
      WORKSPACE_ROOT,
      undefined,
      () => null,
    );

    const { manifest } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array(),
        },
        {
          path: "prompts/USER.md",
          data: new TextEncoder().encode(LEGACY_USER_MD_CONTENT),
        },
      ],
      ...defaultV1Options(),
    });

    const report = analyzeImport({ manifest, pathResolver: resolver });

    // Guardian-less workspaces must not block preflight — the commit-time
    // path warns and skips, so preflight mirrors that behavior.
    expect(report.can_import).toBe(true);
    expect(report.conflicts).toHaveLength(0);
    const userMd = report.files.find((f) => f.path === "prompts/USER.md");
    expect(userMd!.action).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// commitImport — end-to-end legacy USER.md import
// ---------------------------------------------------------------------------

describe("commitImport for legacy prompts/USER.md", () => {
  test("writes legacy USER.md content into users/<slug>.md", () => {
    const slug = "captain.md";
    const guardianPath = join(USERS_DIR, slug);
    const resolver = new DefaultPathResolver(
      WORKSPACE_ROOT,
      undefined,
      () => guardianPath,
    );

    const { archive } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array(),
        },
        {
          path: "prompts/USER.md",
          data: new TextEncoder().encode(LEGACY_USER_MD_CONTENT),
        },
      ],
      ...defaultV1Options(),
    });

    const result = commitImport({
      archiveData: archive,
      pathResolver: resolver,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.success).toBe(true);
      // The bundle carries both data/db/assistant.db and prompts/USER.md;
      // the legacy USER.md is the one we care about here.
      expect(
        result.report.files.find((f) => f.path === "prompts/USER.md")?.action,
      ).toBe("created");
    }

    expect(existsSync(guardianPath)).toBe(true);
    expect(readFileSync(guardianPath, "utf-8")).toBe(LEGACY_USER_MD_CONTENT);
  });

  test("overwrites a pristine scaffold users/<slug>.md", () => {
    const slug = "captain.md";
    const guardianPath = join(USERS_DIR, slug);
    writeFileSync(guardianPath, PRISTINE_SCAFFOLD, "utf-8");

    const resolver = new DefaultPathResolver(
      WORKSPACE_ROOT,
      undefined,
      () => guardianPath,
    );

    const { archive } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array(),
        },
        {
          path: "prompts/USER.md",
          data: new TextEncoder().encode(LEGACY_USER_MD_CONTENT),
        },
      ],
      ...defaultV1Options(),
    });

    const result = commitImport({
      archiveData: archive,
      pathResolver: resolver,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.report.files.find((f) => f.path === "prompts/USER.md")?.action,
      ).toBe("overwritten");
    }
    expect(readFileSync(guardianPath, "utf-8")).toBe(LEGACY_USER_MD_CONTENT);
  });

  test("skips with a warning when no guardian exists (no crash)", () => {
    const resolver = new DefaultPathResolver(
      WORKSPACE_ROOT,
      undefined,
      () => null,
    );

    const { archive } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array(),
        },
        {
          path: "prompts/USER.md",
          data: new TextEncoder().encode(LEGACY_USER_MD_CONTENT),
        },
      ],
      ...defaultV1Options(),
    });

    const result = commitImport({
      archiveData: archive,
      pathResolver: resolver,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.report.files.find((f) => f.path === "prompts/USER.md")?.action,
      ).toBe("skipped");
      expect(
        result.report.warnings.some((w) => w.includes("prompts/USER.md")),
      ).toBe(true);
    }

    // No stray file was written anywhere in users/.
    expect(existsSync(join(USERS_DIR, "USER.md"))).toBe(false);
  });

  test("does NOT overwrite a customized users/<slug>.md", () => {
    const slug = "captain.md";
    const guardianPath = join(USERS_DIR, slug);
    writeFileSync(guardianPath, CUSTOMIZED_PERSONA, "utf-8");

    const resolver = new DefaultPathResolver(
      WORKSPACE_ROOT,
      undefined,
      () => guardianPath,
    );

    const { archive } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array(),
        },
        {
          path: "prompts/USER.md",
          data: new TextEncoder().encode(LEGACY_USER_MD_CONTENT),
        },
      ],
      ...defaultV1Options(),
    });

    const result = commitImport({
      archiveData: archive,
      pathResolver: resolver,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.report.files.find((f) => f.path === "prompts/USER.md")?.action,
      ).toBe("skipped");
      expect(
        result.report.warnings.some((w) => w.includes("guardian persona")),
      ).toBe(true);
    }

    // Existing customized content is preserved byte-for-byte.
    expect(readFileSync(guardianPath, "utf-8")).toBe(CUSTOMIZED_PERSONA);
  });
});
