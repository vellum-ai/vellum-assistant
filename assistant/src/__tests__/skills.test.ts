import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { parse as parseYaml } from "yaml";

const TEST_DIR = process.env.VELLUM_WORKSPACE_DIR!;

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realLogger = require("../util/logger.js");
mock.module("../util/logger.js", () => ({
  ...realLogger,
  getLogger: () => noopLogger,
  getCliLogger: () => noopLogger,
  truncateForLog: (v: string) => v,
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
}));

const { loadSkillCatalog, loadSkillBySelector, resolveSkillSelector } =
  await import("../config/skills.js");

/** Return only user-installed skills (filters out bundled skills that ship with the source tree). */
function loadUserSkillCatalog() {
  return loadSkillCatalog().filter((s) => !s.bundled);
}

function writeSkill(
  skillId: string,
  name: string,
  description: string,
  body: string = "Skill body",
): void {
  const skillDir = join(TEST_DIR, "skills", skillId);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: "${name}"\ndescription: "${description}"\n---\n\n${body}\n`,
  );
}

describe("skills catalog loading", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
  });

  afterEach(() => {
    const skillsDir = join(TEST_DIR, "skills");
    if (existsSync(skillsDir))
      rmSync(skillsDir, { recursive: true, force: true });
  });

  test("discovers valid skill directories alphabetically", () => {
    writeSkill("zeta", "Zeta Skill", "Zeta");
    writeSkill("alpha", "Alpha Skill", "Alpha");

    const catalog = loadUserSkillCatalog();
    expect(catalog.map((skill) => skill.id)).toEqual(["alpha", "zeta"]);
  });

  test("ignores stale SKILLS.md while discovering valid skill directories", () => {
    writeSkill("first", "First Skill", "First");
    writeSkill("second", "Second Skill", "Second");
    writeFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "- second\n- missing\n",
    );

    const catalog = loadUserSkillCatalog();
    expect(catalog.map((skill) => skill.id)).toEqual(["first", "second"]);
  });

  test("managed skill overrides bundled skill with the same id", () => {
    writeSkill(
      "skill-management",
      "Custom Skill Management",
      "Managed override",
    );

    const skill = loadSkillCatalog().find((s) => s.id === "skill-management");
    expect(skill).toBeDefined();
    expect(skill!.source).toBe("managed");
    expect(skill!.name).toBe("Custom Skill Management");
    expect(skill!.bundled).toBeUndefined();
  });

  test("discovers symlinked skill directories that point inside $VELLUM_WORKSPACE_DIR/skills", () => {
    const internalSkillDir = join(
      TEST_DIR,
      "skills",
      ".linked-targets",
      "internal-skill",
    );
    mkdirSync(internalSkillDir, { recursive: true });
    writeFileSync(
      join(internalSkillDir, "SKILL.md"),
      '---\nname: "Internal Linked Skill"\ndescription: "Inside skills root."\n---\n\nLoad me.\n',
    );

    symlinkSync(internalSkillDir, join(TEST_DIR, "skills", "linked-skill"));

    const catalog = loadUserSkillCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0].id).toBe("linked-skill");
    expect(catalog[0].name).toBe("Internal Linked Skill");
  });

  test("does not discover symlinked skill directories that point outside $VELLUM_WORKSPACE_DIR/skills", () => {
    const externalSkillDir = join(TEST_DIR, "outside", "external-skill");
    mkdirSync(externalSkillDir, { recursive: true });
    writeFileSync(
      join(externalSkillDir, "SKILL.md"),
      '---\nname: "External Skill"\ndescription: "Outside skills root."\n---\n\nDo not load.\n',
    );

    symlinkSync(externalSkillDir, join(TEST_DIR, "skills", "linked-skill"));

    const catalog = loadUserSkillCatalog();
    expect(catalog).toHaveLength(0);
  });

  test("rejects symlinked SKILL.md files that point outside $VELLUM_WORKSPACE_DIR/skills", () => {
    const linkedSkillDir = join(TEST_DIR, "skills", "linked-file-skill");
    mkdirSync(linkedSkillDir, { recursive: true });

    const outsideDir = join(TEST_DIR, "outside");
    mkdirSync(outsideDir, { recursive: true });
    const externalSkillFile = join(outsideDir, "external-skill.md");
    writeFileSync(
      externalSkillFile,
      '---\nname: "External File Skill"\ndescription: "Outside skills root."\n---\n\nDo not load.\n',
    );

    symlinkSync(externalSkillFile, join(linkedSkillDir, "SKILL.md"));

    const catalog = loadUserSkillCatalog();
    expect(catalog).toHaveLength(0);
  });
});

describe("workspace skills", () => {
  const WORKSPACE_DIR = join(
    tmpdir(),
    `vellum-workspace-test-${crypto.randomUUID()}`,
  );
  const workspaceSkillsDir = join(WORKSPACE_DIR, ".vellum", "skills");

  function writeWorkspaceSkill(
    skillId: string,
    name: string,
    description: string,
    body: string = "Workspace skill body",
  ): void {
    const skillDir = join(workspaceSkillsDir, skillId);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: "${name}"\ndescription: "${description}"\n---\n\n${body}\n`,
    );
  }

  beforeEach(() => {
    mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
    mkdirSync(workspaceSkillsDir, { recursive: true });
  });

  afterEach(() => {
    const skillsDir = join(TEST_DIR, "skills");
    if (existsSync(skillsDir))
      rmSync(skillsDir, { recursive: true, force: true });
    const outsideDir = join(TEST_DIR, "outside");
    if (existsSync(outsideDir))
      rmSync(outsideDir, { recursive: true, force: true });
    if (existsSync(WORKSPACE_DIR)) {
      rmSync(WORKSPACE_DIR, { recursive: true, force: true });
    }
  });

  test("workspace skills appear in catalog when workspaceSkillsDir is provided", () => {
    writeWorkspaceSkill("ws-skill", "Workspace Skill", "A workspace skill");

    const catalog = loadSkillCatalog(workspaceSkillsDir);
    const wsSkills = catalog.filter((s) => s.source === "workspace");
    expect(wsSkills).toHaveLength(1);
    expect(wsSkills[0].id).toBe("ws-skill");
  });

  test("resolveSkillSelector finds workspace skills when workspaceSkillsDir is provided", () => {
    writeWorkspaceSkill(
      "ws-resolve",
      "Workspace Resolve",
      "Resolvable workspace skill",
    );

    const result = resolveSkillSelector("ws-resolve", workspaceSkillsDir);
    expect(result.skill).toBeDefined();
    expect(result.skill!.id).toBe("ws-resolve");
    expect(result.skill!.source).toBe("workspace");
  });

  test("resolveSkillSelector does not find workspace skills without workspaceSkillsDir", () => {
    writeWorkspaceSkill("ws-hidden", "Hidden Workspace", "Should not be found");

    const result = resolveSkillSelector("ws-hidden");
    expect(result.skill).toBeUndefined();
    expect(result.error).toBeDefined();
  });

  test("loadSkillBySelector loads workspace skill body without isOutsideSkillsRoot rejection", () => {
    writeWorkspaceSkill(
      "ws-load",
      "Loadable Workspace",
      "Can be loaded",
      "Full workspace body here",
    );

    const result = loadSkillBySelector("ws-load", workspaceSkillsDir);
    expect(result.error).toBeUndefined();
    expect(result.skill).toBeDefined();
    expect(result.skill!.id).toBe("ws-load");
    expect(result.skill!.body).toBe("Full workspace body here");
    expect(result.skill!.source).toBe("workspace");
  });

  test("workspace skill overrides managed skill with the same id", () => {
    writeSkill("shared-id", "Managed Shared", "Managed version");
    writeWorkspaceSkill("shared-id", "Workspace Shared", "Workspace version");

    const skill = loadSkillCatalog(workspaceSkillsDir).find(
      (s) => s.id === "shared-id",
    );
    expect(skill).toBeDefined();
    expect(skill!.source).toBe("workspace");
    expect(skill!.name).toBe("Workspace Shared");
  });
});

describe("plugin-resident skills", () => {
  const pluginsDir = join(TEST_DIR, "plugins");

  /**
   * Materialize a skill on disk inside an installed plugin directory:
   * `plugins/<plugin>/skills/<skillId>/SKILL.md`. A `package.json` is written
   * for the plugin by default since that is the install gate the discovery
   * scan keys on; pass `withPackageJson: false` to simulate a stray directory.
   */
  function writePluginSkill(
    pluginName: string,
    skillId: string,
    name: string,
    description: string,
    body: string = "Plugin skill body",
    {
      withPackageJson = true,
      packageName,
    }: { withPackageJson?: boolean; packageName?: string } = {},
  ): void {
    const pluginDir = join(pluginsDir, pluginName);
    mkdirSync(pluginDir, { recursive: true });
    if (withPackageJson) {
      writeFileSync(
        join(pluginDir, "package.json"),
        JSON.stringify({ name: packageName ?? pluginName, version: "1.0.0" }),
      );
    }
    const skillDir = join(pluginDir, "skills", skillId);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: "${name}"\ndescription: "${description}"\n---\n\n${body}\n`,
    );
  }

  beforeEach(() => {
    mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
  });

  afterEach(() => {
    for (const dir of [join(TEST_DIR, "skills"), pluginsDir]) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  test("discovers skills shipped inside an installed plugin, attributed to it", () => {
    writePluginSkill("caveman", "caveman", "Caveman", "Terse mode");

    const skill = loadSkillCatalog().find((s) => s.id === "caveman");
    expect(skill).toBeDefined();
    expect(skill!.source).toBe("plugin");
    expect(skill!.owner).toEqual({ kind: "plugin", id: "caveman" });
  });

  test("loadSkillBySelector loads a plugin-resident skill body", () => {
    writePluginSkill(
      "caveman",
      "caveman",
      "Caveman",
      "Terse mode",
      "Full plugin skill body",
    );

    const result = loadSkillBySelector("caveman");
    expect(result.error).toBeUndefined();
    expect(result.skill).toBeDefined();
    expect(result.skill!.source).toBe("plugin");
    expect(result.skill!.body).toBe("Full plugin skill body");
    expect(result.skill!.owner).toEqual({ kind: "plugin", id: "caveman" });
  });

  test("ignores plugin directories without a package.json (staging/stray dirs)", () => {
    writePluginSkill(
      "half-installed",
      "ghost",
      "Ghost",
      "Should be skipped",
      "body",
      { withPackageJson: false },
    );

    const skill = loadSkillCatalog().find((s) => s.id === "ghost");
    expect(skill).toBeUndefined();
  });

  test("surfaces plugin skills when package.json name differs from the directory", () => {
    // A plugin is installed under its slug (marketplace name or GitHub path
    // leaf), which routinely differs from its authored `package.json` name —
    // e.g. cognee installs to `cognee`/`vellum-assistant` while its package is
    // named `cognee-memory`. The skill must still surface, attributed to the
    // install directory (the identity every other surface uses).
    writePluginSkill("caveman", "caveman", "Caveman", "Terse mode", "body", {
      packageName: "caveman-installer",
    });

    const skill = loadSkillCatalog().find((s) => s.id === "caveman");
    expect(skill).toBeDefined();
    expect(skill!.source).toBe("plugin");
    expect(skill!.owner).toEqual({ kind: "plugin", id: "caveman" });
  });

  test("warns when a plugin directory is missing package.json", () => {
    const warnings: unknown[][] = [];
    const originalWarn = noopLogger.warn;
    noopLogger.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      writePluginSkill(
        "the-force",
        "software-engineering",
        "Software Engineering",
        "Engineering workflow",
        "body",
        { withPackageJson: false },
      );

      const skill = loadSkillCatalog().find(
        (s) => s.id === "software-engineering",
      );
      expect(skill).toBeUndefined();

      const warnedForDir = warnings.some(
        (args) =>
          typeof args[0] === "object" &&
          args[0] !== null &&
          "pluginDir" in args[0] &&
          (args[0] as { pluginDir: string }).pluginDir.endsWith("the-force") &&
          typeof args[1] === "string" &&
          args[1].includes("missing package.json"),
      );
      expect(warnedForDir).toBe(true);
    } finally {
      noopLogger.warn = originalWarn;
    }
  });

  test("does not load resident skills from a plugin disabled via .disabled", () => {
    writePluginSkill("caveman", "caveman", "Caveman", "Terse mode");
    writeFileSync(join(pluginsDir, "caveman", ".disabled"), "");

    const skill = loadSkillCatalog().find((s) => s.id === "caveman");
    expect(skill).toBeUndefined();
  });

  test("workspace skill overrides a plugin-resident skill with the same id", () => {
    const WORKSPACE_DIR = join(
      tmpdir(),
      `vellum-workspace-test-${crypto.randomUUID()}`,
    );
    const workspaceSkillsDir = join(WORKSPACE_DIR, ".vellum", "skills");
    mkdirSync(join(workspaceSkillsDir, "shared-id"), { recursive: true });
    writeFileSync(
      join(workspaceSkillsDir, "shared-id", "SKILL.md"),
      `---\nname: "Workspace Wins"\ndescription: "Workspace version"\n---\n\nbody\n`,
    );
    writePluginSkill("caveman", "shared-id", "Plugin Loses", "Plugin version");

    try {
      const skill = loadSkillCatalog(workspaceSkillsDir).find(
        (s) => s.id === "shared-id",
      );
      expect(skill).toBeDefined();
      expect(skill!.source).toBe("workspace");
      expect(skill!.name).toBe("Workspace Wins");
    } finally {
      rmSync(WORKSPACE_DIR, { recursive: true, force: true });
    }
  });
});

describe("tool manifest detection", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
  });

  afterEach(() => {
    const skillsDir = join(TEST_DIR, "skills");
    if (existsSync(skillsDir))
      rmSync(skillsDir, { recursive: true, force: true });
  });

  test("attaches toolManifest metadata when valid TOOLS.json is present", () => {
    writeSkill("with-tools", "Tool Skill", "Skill with tools");
    const toolsJson = {
      version: 1,
      tools: [
        {
          name: "run-lint",
          description: "Runs linting",
          category: "quality",
          risk: "low",
          input_schema: { type: "object", properties: {} },
          executor: "lint.sh",
          execution_target: "host",
        },
        {
          name: "run-test",
          description: "Runs tests",
          category: "quality",
          risk: "medium",
          input_schema: { type: "object", properties: {} },
          executor: "test.sh",
          execution_target: "sandbox",
        },
      ],
    };
    writeFileSync(
      join(TEST_DIR, "skills", "with-tools", "TOOLS.json"),
      JSON.stringify(toolsJson),
    );

    const catalog = loadUserSkillCatalog();
    const skill = catalog.find((s) => s.id === "with-tools");
    expect(skill).toBeDefined();
    expect(skill!.toolManifest).toEqual({
      present: true,
      valid: true,
      toolCount: 2,
      toolNames: ["run-lint", "run-test"],
      versionHash: expect.stringMatching(/^v1:[0-9a-f]{64}$/),
    });
  });

  test("marks toolManifest as invalid when TOOLS.json fails to parse", () => {
    writeSkill("bad-tools", "Bad Tool Skill", "Skill with invalid tools");
    writeFileSync(
      join(TEST_DIR, "skills", "bad-tools", "TOOLS.json"),
      "{ not valid json !!!",
    );

    const catalog = loadUserSkillCatalog();
    const skill = catalog.find((s) => s.id === "bad-tools");
    expect(skill).toBeDefined();
    expect(skill!.toolManifest).toEqual({
      present: true,
      valid: false,
      toolCount: 0,
      toolNames: [],
      versionHash: expect.stringMatching(/^v1:[0-9a-f]{64}$/),
    });
  });

  test("marks toolManifest as invalid when TOOLS.json has schema errors", () => {
    writeSkill(
      "schema-error",
      "Schema Error Skill",
      "Skill with schema errors",
    );
    // Valid JSON but missing required fields
    writeFileSync(
      join(TEST_DIR, "skills", "schema-error", "TOOLS.json"),
      JSON.stringify({ version: 1, tools: [{ name: "incomplete" }] }),
    );

    const catalog = loadUserSkillCatalog();
    const skill = catalog.find((s) => s.id === "schema-error");
    expect(skill).toBeDefined();
    expect(skill!.toolManifest).toEqual({
      present: true,
      valid: false,
      toolCount: 0,
      toolNames: [],
      versionHash: expect.stringMatching(/^v1:[0-9a-f]{64}$/),
    });
  });

  test("does not set toolManifest when TOOLS.json is absent", () => {
    writeSkill("no-tools", "No Tool Skill", "Skill without tools");

    const catalog = loadUserSkillCatalog();
    const skill = catalog.find((s) => s.id === "no-tools");
    expect(skill).toBeDefined();
    expect(skill!.toolManifest).toBeUndefined();
  });

  test("versionHash is a v1: prefixed string when TOOLS.json is valid", () => {
    writeSkill(
      "hash-valid",
      "Hash Valid Skill",
      "Skill with valid tools for hash check",
    );
    const toolsJson = {
      version: 1,
      tools: [
        {
          name: "hash-tool",
          description: "A tool for hash testing",
          category: "test",
          risk: "low",
          input_schema: { type: "object", properties: {} },
          executor: "run.sh",
          execution_target: "host",
        },
      ],
    };
    writeFileSync(
      join(TEST_DIR, "skills", "hash-valid", "TOOLS.json"),
      JSON.stringify(toolsJson),
    );

    const catalog = loadUserSkillCatalog();
    const skill = catalog.find((s) => s.id === "hash-valid");
    expect(skill).toBeDefined();
    expect(skill!.toolManifest).toBeDefined();
    expect(typeof skill!.toolManifest!.versionHash).toBe("string");
    expect(skill!.toolManifest!.versionHash).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  test("versionHash is computed even when TOOLS.json is invalid", () => {
    writeSkill(
      "hash-invalid",
      "Hash Invalid Skill",
      "Skill with invalid tools for hash check",
    );
    writeFileSync(
      join(TEST_DIR, "skills", "hash-invalid", "TOOLS.json"),
      "{ broken json",
    );

    const catalog = loadUserSkillCatalog();
    const skill = catalog.find((s) => s.id === "hash-invalid");
    expect(skill).toBeDefined();
    expect(skill!.toolManifest).toBeDefined();
    expect(skill!.toolManifest!.valid).toBe(false);
    // Hash is based on the directory content, not manifest validity
    expect(typeof skill!.toolManifest!.versionHash).toBe("string");
    expect(skill!.toolManifest!.versionHash).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  test("toolManifest is undefined when TOOLS.json is absent (no hash computed)", () => {
    writeSkill(
      "hash-absent",
      "Hash Absent Skill",
      "Skill without tools for hash check",
    );

    const catalog = loadUserSkillCatalog();
    const skill = catalog.find((s) => s.id === "hash-absent");
    expect(skill).toBeDefined();
    expect(skill!.toolManifest).toBeUndefined();
  });
});

describe("includes frontmatter parsing", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
  });

  afterEach(() => {
    const skillsDir = join(TEST_DIR, "skills");
    if (existsSync(skillsDir))
      rmSync(skillsDir, { recursive: true, force: true });
  });

  function writeSkillWithIncludes(skillId: string, includes: string): void {
    const skillDir = join(TEST_DIR, "skills", skillId);
    mkdirSync(skillDir, { recursive: true });
    // includes lives inside metadata.vellum, matching buildSkillMarkdown output.
    // The raw includes string is interpolated directly so tests can pass both
    // valid and intentionally malformed values.
    const metadata = `{"vellum":{"includes":${includes}}}`;
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: "${skillId}"\ndescription: "test"\nmetadata: ${metadata}\n---\n\nBody.\n`,
    );
  }

  test("parses valid includes array", () => {
    writeSkillWithIncludes("parent", '["child-a", "child-b"]');
    const catalog = loadUserSkillCatalog();
    const skill = catalog.find((s) => s.id === "parent");
    expect(skill).toBeDefined();
    expect(skill!.includes).toEqual(["child-a", "child-b"]);
  });

  test("trims whitespace in includes entries", () => {
    writeSkillWithIncludes("parent", '["  child-a  ", " child-b "]');
    const catalog = loadUserSkillCatalog();
    const skill = catalog.find((s) => s.id === "parent");
    expect(skill!.includes).toEqual(["child-a", "child-b"]);
  });

  test("removes empty strings from includes", () => {
    writeSkillWithIncludes("parent", '["child-a", "", "  ", "child-b"]');
    const catalog = loadUserSkillCatalog();
    const skill = catalog.find((s) => s.id === "parent");
    expect(skill!.includes).toEqual(["child-a", "child-b"]);
  });

  test("deduplicates includes preserving first-seen order", () => {
    writeSkillWithIncludes("parent", '["child-a", "child-b", "child-a"]');
    const catalog = loadUserSkillCatalog();
    const skill = catalog.find((s) => s.id === "parent");
    expect(skill!.includes).toEqual(["child-a", "child-b"]);
  });

  test("returns undefined for invalid JSON", () => {
    writeSkillWithIncludes("parent", "not-json");
    const catalog = loadUserSkillCatalog();
    const skill = catalog.find((s) => s.id === "parent");
    expect(skill!.includes).toBeUndefined();
  });

  test("returns undefined for non-array JSON", () => {
    writeSkillWithIncludes("parent", '"just-a-string"');
    const catalog = loadUserSkillCatalog();
    const skill = catalog.find((s) => s.id === "parent");
    expect(skill!.includes).toBeUndefined();
  });

  test("returns undefined for array with non-string elements", () => {
    writeSkillWithIncludes("parent", "[123, true]");
    const catalog = loadUserSkillCatalog();
    const skill = catalog.find((s) => s.id === "parent");
    expect(skill!.includes).toBeUndefined();
  });

  test("returns undefined for empty array", () => {
    writeSkillWithIncludes("parent", "[]");
    const catalog = loadUserSkillCatalog();
    const skill = catalog.find((s) => s.id === "parent");
    expect(skill!.includes).toBeUndefined();
  });

  test("skill without includes has undefined includes", () => {
    writeSkill("no-includes", "No Includes", "Test");
    const catalog = loadUserSkillCatalog();
    const skill = catalog.find((s) => s.id === "no-includes");
    expect(skill!.includes).toBeUndefined();
  });
});

describe("category frontmatter parsing", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
  });

  afterEach(() => {
    const skillsDir = join(TEST_DIR, "skills");
    if (existsSync(skillsDir))
      rmSync(skillsDir, { recursive: true, force: true });
  });

  function writeSkillWithCategory(skillId: string, category: string): void {
    const skillDir = join(TEST_DIR, "skills", skillId);
    mkdirSync(skillDir, { recursive: true });
    const metadata = `{"vellum":{"category":${category}}}`;
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: "${skillId}"\ndescription: "test"\nmetadata: ${metadata}\n---\n\nBody.\n`,
    );
  }

  test("parses category from metadata.vellum", () => {
    writeSkillWithCategory("categorized", '"productivity"');
    const skill = loadUserSkillCatalog().find((s) => s.id === "categorized");
    expect(skill!.category).toBe("productivity");
  });

  test("trims whitespace in category", () => {
    writeSkillWithCategory("padded", '"  email  "');
    const skill = loadUserSkillCatalog().find((s) => s.id === "padded");
    expect(skill!.category).toBe("email");
  });

  test("returns undefined for empty category", () => {
    writeSkillWithCategory("empty", '"  "');
    const skill = loadUserSkillCatalog().find((s) => s.id === "empty");
    expect(skill!.category).toBeUndefined();
  });

  test("returns undefined for non-string category", () => {
    writeSkillWithCategory("numeric", "42");
    const skill = loadUserSkillCatalog().find((s) => s.id === "numeric");
    expect(skill!.category).toBeUndefined();
  });

  test("skill without category has undefined category", () => {
    writeSkill("no-category", "No Category", "Test");
    const skill = loadUserSkillCatalog().find((s) => s.id === "no-category");
    expect(skill!.category).toBeUndefined();
  });
});

describe("always-candidate frontmatter parsing", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
  });

  afterEach(() => {
    const skillsDir = join(TEST_DIR, "skills");
    if (existsSync(skillsDir))
      rmSync(skillsDir, { recursive: true, force: true });
  });

  function writeSkillWithAlwaysCandidate(skillId: string, value: string): void {
    const skillDir = join(TEST_DIR, "skills", skillId);
    mkdirSync(skillDir, { recursive: true });
    const metadata = `{"vellum":{"always-candidate":${value}}}`;
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: "${skillId}"\ndescription: "test"\nmetadata: ${metadata}\n---\n\nBody.\n`,
    );
  }

  test("parses always-candidate: true from metadata.vellum", () => {
    writeSkillWithAlwaysCandidate("pinned", "true");
    const skill = loadUserSkillCatalog().find((s) => s.id === "pinned");
    expect(skill!.alwaysCandidate).toBe(true);
  });

  test("parses always-candidate: false", () => {
    writeSkillWithAlwaysCandidate("unpinned", "false");
    const skill = loadUserSkillCatalog().find((s) => s.id === "unpinned");
    expect(skill!.alwaysCandidate).toBe(false);
  });

  test("returns undefined for a non-boolean always-candidate", () => {
    writeSkillWithAlwaysCandidate("bad", '"yes"');
    const skill = loadUserSkillCatalog().find((s) => s.id === "bad");
    expect(skill!.alwaysCandidate).toBeUndefined();
  });

  test("skill without always-candidate has undefined", () => {
    writeSkill("plain", "Plain", "Test");
    const skill = loadUserSkillCatalog().find((s) => s.id === "plain");
    expect(skill!.alwaysCandidate).toBeUndefined();
  });

  test("the bundled workflows skill is flagged always-candidate", () => {
    const wf = loadSkillCatalog().find((s) => s.id === "workflows");
    expect(wf?.alwaysCandidate).toBe(true);
  });
});

describe("bundled skill categories", () => {
  test("every bundled skill declares a valid category slug", () => {
    const yamlPath = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "skills",
      "skill-categories-catalog.yaml",
    );
    const parsed = parseYaml(readFileSync(yamlPath, "utf-8")) as {
      categories: { slug: string }[];
    };
    const validSlugs = new Set(parsed.categories.map((c) => c.slug));
    expect(validSlugs.size).toBeGreaterThan(0);

    const bundled = loadSkillCatalog().filter((s) => s.bundled);
    expect(bundled.length).toBeGreaterThan(0);
    const invalid = bundled
      .filter((s) => !s.category || !validSlugs.has(s.category))
      .map((s) => `${s.id}: ${s.category ?? "(missing)"}`);
    expect(invalid).toEqual([]);
  });
});

describe("managed browser skill", () => {
  const BROWSER_SKILL_MD = readFileSync(
    join(import.meta.dirname, "../../../skills/vellum-browser-use/SKILL.md"),
    "utf-8",
  );

  beforeEach(() => {
    const skillDir = join(TEST_DIR, "skills", "vellum-browser-use");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), BROWSER_SKILL_MD);
  });

  afterEach(() => {
    const skillsDir = join(TEST_DIR, "skills");
    if (existsSync(skillsDir))
      rmSync(skillsDir, { recursive: true, force: true });
  });

  test("browser skill appears in full catalog", () => {
    const catalog = loadSkillCatalog();
    const browserSkill = catalog.find((s) => s.id === "vellum-browser-use");
    expect(browserSkill).toBeDefined();
    expect(browserSkill!.name).toBe("vellum-browser-use");
    expect(browserSkill!.displayName).toBe("Browser");
  });

  test("browser skill has correct metadata", () => {
    const catalog = loadSkillCatalog();
    const browserSkill = catalog.find((s) => s.id === "vellum-browser-use");
    expect(browserSkill).toBeDefined();
    expect(browserSkill!.description).toBe(
      "Browse the web using `assistant browser` CLI commands",
    );
  });

  test("browser skill has no tool manifest", () => {
    const catalog = loadSkillCatalog();
    const browserSkill = catalog.find((s) => s.id === "vellum-browser-use");
    expect(browserSkill).toBeDefined();
    // Browser tools are dispatched via skill_execute and do not use
    // a skill-tool manifest.
    expect(browserSkill!.toolManifest).toBeUndefined();
  });
});

describe("ingress-dependent setup skills declare public-ingress intentionally", () => {
  const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
  const FIRST_PARTY_SKILLS_DIR = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "skills",
  );

  function readSkillIncludes(
    dir: string,
    skillId: string,
  ): string[] | undefined {
    const content = readFileSync(join(dir, skillId, "SKILL.md"), "utf-8");
    const match = content.match(FRONTMATTER_REGEX);
    if (!match) return undefined;
    for (const line of match[1].split(/\r?\n/)) {
      const sep = line.indexOf(":");
      if (sep === -1) continue;
      const key = line.slice(0, sep).trim();
      // Check top-level includes (legacy format)
      if (key === "includes") {
        const val = line.slice(sep + 1).trim();
        try {
          const parsed = JSON.parse(val);
          if (Array.isArray(parsed)) return parsed as string[];
        } catch {
          /* ignore */
        }
      }
      // Check metadata.vellum.includes (spec-compliant format)
      if (key === "metadata") {
        const val = line.slice(sep + 1).trim();
        try {
          const parsed = JSON.parse(val);
          const includes = parsed?.vellum?.includes;
          if (Array.isArray(includes)) return includes as string[];
        } catch {
          /* ignore */
        }
      }
    }
    return undefined;
  }

  test("telegram-setup does not hard-depend on public-ingress", () => {
    const includes = readSkillIncludes(
      FIRST_PARTY_SKILLS_DIR,
      "telegram-setup",
    );
    expect(includes ?? []).not.toContain("public-ingress");
  });

  test("twilio-setup includes public-ingress", () => {
    const includes = readSkillIncludes(FIRST_PARTY_SKILLS_DIR, "twilio-setup");
    expect(includes).toBeDefined();
    expect(includes).toContain("public-ingress");
  });

  test("public-ingress frontmatter advertises managed-mode avoidance", () => {
    const content = readFileSync(
      join(FIRST_PARTY_SKILLS_DIR, "public-ingress", "SKILL.md"),
      "utf-8",
    );
    expect(content).toContain("avoid-when:");
    expect(content.toLowerCase()).toContain("platform-managed");
  });
});

describe("bundled computer-use skill", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
  });

  afterEach(() => {
    const skillsDir = join(TEST_DIR, "skills");
    if (existsSync(skillsDir))
      rmSync(skillsDir, { recursive: true, force: true });
  });

  test("computer-use skill appears in full catalog (including bundled)", () => {
    const catalog = loadSkillCatalog();
    const cuSkill = catalog.find((s) => s.id === "computer-use");
    expect(cuSkill).toBeDefined();
    expect(cuSkill!.name).toBe("computer-use");
    expect(cuSkill!.displayName).toBe("Computer Use");
    expect(cuSkill!.bundled).toBe(true);
  });

  test("computer-use skill has a valid tool manifest with 11 tools", () => {
    const catalog = loadSkillCatalog();
    const cuSkill = catalog.find((s) => s.id === "computer-use");
    expect(cuSkill).toBeDefined();
    expect(cuSkill!.toolManifest).toBeDefined();
    expect(cuSkill!.toolManifest!.present).toBe(true);
    expect(cuSkill!.toolManifest!.valid).toBe(true);
    expect(cuSkill!.toolManifest!.toolCount).toBe(11);
    expect(cuSkill!.toolManifest!.toolNames).toEqual([
      "computer_use_observe",
      "computer_use_click",
      "computer_use_type_text",
      "computer_use_key",
      "computer_use_scroll",
      "computer_use_drag",
      "computer_use_wait",
      "computer_use_open_app",
      "computer_use_run_applescript",
      "computer_use_done",
      "computer_use_respond",
    ]);
  });
});

describe("skill source ownership", () => {
  const BUNDLED_SKILLS_DIR = join(
    import.meta.dir,
    "..",
    "config",
    "bundled-skills",
  );
  const FIRST_PARTY_SKILLS_DIR = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "skills",
  );

  function collectSourceSkillIds(rootDir: string): string[] {
    return readdirSync(rootDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          existsSync(join(rootDir, entry.name, "SKILL.md")),
      )
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  }

  test("bundled skills are not duplicated in the first-party source catalog", () => {
    const firstPartyIds = new Set(
      collectSourceSkillIds(FIRST_PARTY_SKILLS_DIR),
    );
    const duplicates = collectSourceSkillIds(BUNDLED_SKILLS_DIR).filter((id) =>
      firstPartyIds.has(id),
    );

    expect(duplicates).toEqual([]);
  });
});
