import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

import {
  buildPublishPayload,
  findPluginRoot,
  formatPayloadForPrint,
  formatPublishResult,
  formatValidationResult,
  type ParsedPackageJson,
  type PublishValidation,
  runPublish,
  validatePluginForPublish,
} from "../publish-plugin.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePluginDir(
  base: string,
  pkg: Partial<ParsedPackageJson> = {},
  surfaces: { hooks?: boolean; tools?: boolean; skills?: boolean } = {},
): string {
  const dir = mkdtempSync(join(base, "plugin-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "test-plugin",
      version: "1.0.0",
      description: "A test plugin",
      license: "MIT",
      homepage: "https://github.com/test/test-plugin",
      peerDependencies: { "@vellumai/plugin-api": "^1.0.0" },
      ...pkg,
    }),
  );
  if (surfaces.hooks) {
    mkdirSync(join(dir, "hooks"));
    writeFileSync(join(dir, "hooks", "post-tool-use.ts"), "// hook");
  }
  if (surfaces.tools) {
    mkdirSync(join(dir, "tools"));
    writeFileSync(join(dir, "tools", "my-tool.ts"), "// tool");
  }
  if (surfaces.skills) {
    mkdirSync(join(dir, "skills"));
    writeFileSync(join(dir, "skills", "my-skill"), "content");
  }
  return dir;
}

const validPkg: Partial<ParsedPackageJson> = {
  name: "test-plugin",
  version: "1.0.0",
  peerDependencies: { "@vellumai/plugin-api": "^1.0.0" },
  description: "A test plugin",
  license: "MIT",
  homepage: "https://github.com/test/test-plugin",
};

// ---------------------------------------------------------------------------
// findPluginRoot
// ---------------------------------------------------------------------------

describe("findPluginRoot", () => {
  it("finds package.json in the given directory", () => {
    const dir = makePluginDir(tmpdir());
    expect(findPluginRoot(dir)).toBe(dir);
    rmSync(dir, { recursive: true });
  });

  it("finds package.json in a parent directory", () => {
    const dir = makePluginDir(tmpdir());
    const subDir = join(dir, "subdir");
    mkdirSync(subDir);
    expect(findPluginRoot(subDir)).toBe(dir);
    rmSync(dir, { recursive: true });
  });

  it("returns null when no package.json exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "empty-"));
    expect(findPluginRoot(dir)).toBeNull();
    rmSync(dir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// validatePluginForPublish
// ---------------------------------------------------------------------------

describe("validatePluginForPublish", () => {
  it("passes for a valid plugin with surfaces", () => {
    const dir = makePluginDir(tmpdir(), validPkg, { hooks: true });
    const result = validatePluginForPublish(dir);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
    rmSync(dir, { recursive: true });
  });

  it("fails when package.json is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "no-pkg-"));
    const result = validatePluginForPublish(dir);
    expect(result.valid).toBe(false);
    expect(result.issues).toContain("package.json not found");
    rmSync(dir, { recursive: true });
  });

  it("fails when name is missing", () => {
    const dir = makePluginDir(tmpdir(), {
      ...validPkg,
      name: undefined,
    });
    const result = validatePluginForPublish(dir);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes("missing 'name'"))).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it("fails when name is not kebab-case", () => {
    const dir = makePluginDir(tmpdir(), {
      ...validPkg,
      name: "NotKebabCase",
    });
    const result = validatePluginForPublish(dir);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes("kebab-case"))).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it("fails when version is missing", () => {
    const dir = makePluginDir(tmpdir(), {
      ...validPkg,
      version: undefined,
    });
    const result = validatePluginForPublish(dir);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes("missing 'version'"))).toBe(
      true,
    );
    rmSync(dir, { recursive: true });
  });

  it("fails when @vellumai/plugin-api peer dep is missing", () => {
    const dir = makePluginDir(tmpdir(), {
      ...validPkg,
      peerDependencies: {},
    });
    const result = validatePluginForPublish(dir);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes("@vellumai/plugin-api"))).toBe(
      true,
    );
    rmSync(dir, { recursive: true });
  });

  it("warns when no surface directories have entries", () => {
    const dir = makePluginDir(tmpdir(), validPkg);
    const result = validatePluginForPublish(dir);
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes("No hooks/"))).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it("warns about stale .js without matching .ts", () => {
    const dir = makePluginDir(tmpdir(), validPkg, { hooks: true });
    // Add a stale .js file without a matching .ts
    writeFileSync(join(dir, "hooks", "orphan.js"), "// stale");
    const result = validatePluginForPublish(dir);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("orphan.js"))).toBe(true);
    rmSync(dir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// buildPublishPayload
// ---------------------------------------------------------------------------

describe("buildPublishPayload", () => {
  it("assembles payload from validation and git context", () => {
    const validation: PublishValidation = {
      valid: true,
      issues: [],
      warnings: [],
      packageJson: {
        name: "my-plugin",
        version: "1.0.0",
        description: "Does cool stuff",
        license: "MIT",
        homepage: "https://github.com/me/my-plugin",
        peerDependencies: { "@vellumai/plugin-api": "^1.0.0" },
      },
      pluginDir: "/tmp/plugin",
    };
    const git = {
      sha: "e83c5163316f89bfbde7d9ab23ca2e25604af290",
      repo: "me/my-plugin",
      dirty: false,
      pushed: true,
      pluginPath: "",
    };

    const payload = buildPublishPayload(validation, git, "productivity");

    expect(payload.name).toBe("my-plugin");
    expect(payload.source.source).toBe("github");
    expect(payload.source.repo).toBe("me/my-plugin");
    expect(payload.source.ref).toBe("e83c5163316f89bfbde7d9ab23ca2e25604af290");
    expect(payload.source.path).toBeUndefined();
    expect(payload.category).toBe("productivity");
    expect(payload.description).toBe("Does cool stuff");
    expect(payload.license).toBe("MIT");
    expect(payload.homepage).toBe("https://github.com/me/my-plugin");
  });

  it("sets source.path for nested plugin roots", () => {
    const validation: PublishValidation = {
      valid: true,
      issues: [],
      warnings: [],
      packageJson: {
        name: "my-plugin",
        version: "1.0.0",
        peerDependencies: { "@vellumai/plugin-api": "^1.0.0" },
      },
      pluginDir: "/tmp/monorepo/packages/plugin",
    };
    const git = {
      sha: "e83c5163316f89bfbde7d9ab23ca2e25604af290",
      repo: "me/monorepo",
      dirty: false,
      pushed: true,
      pluginPath: "packages/plugin",
    };

    const payload = buildPublishPayload(validation, git, "other");
    expect(payload.source.path).toBe("packages/plugin");
  });

  it("extracts homepage from repository.url when homepage is absent", () => {
    const validation: PublishValidation = {
      valid: true,
      issues: [],
      warnings: [],
      packageJson: {
        name: "my-plugin",
        version: "1.0.0",
        peerDependencies: { "@vellumai/plugin-api": "^1.0.0" },
        repository: { url: "https://github.com/me/my-plugin.git" },
      },
      pluginDir: "/tmp/plugin",
    };
    const git = {
      sha: "e83c5163316f89bfbde7d9ab23ca2e25604af290",
      repo: "me/my-plugin",
      dirty: false,
      pushed: true,
      pluginPath: "",
    };

    const payload = buildPublishPayload(validation, git, "other");
    expect(payload.homepage).toBe("https://github.com/me/my-plugin");
  });
});

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

describe("formatPayloadForPrint", () => {
  it("produces valid JSON", () => {
    const payload = {
      name: "test",
      source: { source: "github" as const, repo: "me/test", ref: "abc" },
      category: "other",
    };
    const printed = formatPayloadForPrint(payload);
    expect(JSON.parse(printed)).toEqual(payload);
  });
});

describe("formatPublishResult", () => {
  it("formats success", () => {
    const result = formatPublishResult({
      ok: true,
      pr_url: "https://github.com/vellum-ai/vellum-assistant/pull/1",
      pr_number: 1,
      status: "pending_review",
    });
    expect(result).toContain("PR opened");
    expect(result).toContain("review");
  });

  it("formats failure", () => {
    const result = formatPublishResult({
      ok: false,
      error: "rate_limited",
      message: "Too many publishes.",
    });
    expect(result).toContain("failed");
    expect(result).toContain("Too many publishes");
  });
});

describe("formatValidationResult", () => {
  it("formats errors and warnings", () => {
    const result = formatValidationResult({
      valid: false,
      issues: ["Missing name"],
      warnings: ["No surfaces"],
      packageJson: {},
      pluginDir: "/tmp",
    });
    expect(result).toContain("Validation errors");
    expect(result).toContain("Missing name");
    expect(result).toContain("Warnings");
    expect(result).toContain("No surfaces");
  });

  it("formats clean validation", () => {
    const result = formatValidationResult({
      valid: true,
      issues: [],
      warnings: [],
      packageJson: {},
      pluginDir: "/tmp",
    });
    expect(result).toContain("passed");
  });
});

// ---------------------------------------------------------------------------
// runPublish (CLI entrypoint)
// ---------------------------------------------------------------------------

describe("runPublish", () => {
  it("returns false on denied confirmation without submitting", async () => {
    const dir = makePluginDir(tmpdir(), validPkg, { hooks: true });
    // Initialize a git repo so resolveGitContext doesn't fail
    const { execSync } = await import("node:child_process");
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    execSync("git init && git add -A && git commit -m init", {
      cwd: dir,
      stdio: "ignore",
      env: gitEnv,
    });
    execSync("git remote add origin https://github.com/test/test-plugin.git", {
      cwd: dir,
      stdio: "ignore",
      env: gitEnv,
    });

    const ok = await runPublish(
      { path: dir, force: false, json: false },
      {
        confirmPrompt: async () => "denied",
      },
    );

    expect(ok).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it("returns true on --print without submitting", async () => {
    const dir = makePluginDir(tmpdir(), validPkg, { hooks: true });

    const ok = await runPublish(
      { path: dir, print: true, json: true },
      {
        confirmPrompt: async () => {
          throw new Error("should not be called");
        },
      },
    );

    expect(ok).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it("returns false when no package.json found", async () => {
    const dir = mkdtempSync(join(tmpdir(), "no-pkg-"));
    const ok = await runPublish(
      { path: dir, force: true, json: true },
      {
        confirmPrompt: async () => {
          throw new Error("should not be called");
        },
      },
    );

    expect(ok).toBe(false);
    rmSync(dir, { recursive: true });
  });
});
