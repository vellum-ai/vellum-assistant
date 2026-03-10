import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const TEST_DIR = join(tmpdir(), `vellum-skills-test-${crypto.randomUUID()}`);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realPlatform = require("../util/platform.js");
mock.module("../util/platform.js", () => ({
  ...realPlatform,
  getRootDir: () => TEST_DIR,
  getDataDir: () => TEST_DIR,

  getSandboxRootDir: () => join(TEST_DIR, "sandbox"),
  getSandboxWorkingDir: () => TEST_DIR,
  getInterfacesDir: () => join(TEST_DIR, "interfaces"),
  ensureDataDir: () => {},
  getSocketPath: () => join(TEST_DIR, "vellum.sock"),
  getPidPath: () => join(TEST_DIR, "vellum.pid"),
  getDbPath: () => join(TEST_DIR, "data", "assistant.db"),
  getLogPath: () => join(TEST_DIR, "logs", "vellum.log"),
  getHistoryPath: () => join(TEST_DIR, "history"),
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPlatformName: () => process.platform,
  getClipboardCommand: () => null,
  getWorkspaceConfigPath: () => join(TEST_DIR, "config.json"),
  getWorkspaceSkillsDir: () => join(TEST_DIR, "skills"),
  getWorkspaceHooksDir: () => join(TEST_DIR, "hooks"),
  getHooksDir: () => join(TEST_DIR, "hooks"),
  getWorkspaceDir: () => TEST_DIR,
  getWorkspacePromptPath: (file: string) => join(TEST_DIR, file),
  readSessionToken: () => null,
  normalizeAssistantId: (id: string) => id,
  readLockfile: () => null,
  writeLockfile: () => {},
}));

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
  isDebug: () => false,
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
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test("parses markdown list path entries from SKILLS.md", () => {
    writeSkill("alpha", "Alpha Skill", "First skill");
    writeSkill("beta", "Beta Skill", "Second skill");
    writeFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "- alpha\n- beta/SKILL.md\n",
    );

    const catalog = loadUserSkillCatalog();
    expect(catalog.map((skill) => skill.id)).toEqual(["alpha", "beta"]);
  });

  test("resolves markdown links from SKILLS.md", () => {
    writeSkill("lint", "Lint Skill", "Runs lint checks");
    writeSkill("test", "Test Skill", "Runs test checks");
    writeFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "- [Lint](lint)\n- [Tests](test)\n",
    );

    const catalog = loadUserSkillCatalog();
    expect(catalog.map((skill) => skill.id)).toEqual(["lint", "test"]);
  });

  test("rejects SKILLS.md entries that resolve outside ~/.vellum/workspace/skills", () => {
    writeSkill("safe", "Safe Skill", "Safe skill");
    writeFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "- ../escape\n- /tmp/absolute\n- safe\n",
    );

    const catalog = loadUserSkillCatalog();
    expect(catalog.map((skill) => skill.id)).toEqual(["safe"]);
  });

  test("rejects symlinked SKILLS.md entries that point outside ~/.vellum/workspace/skills", () => {
    const externalSkillDir = join(TEST_DIR, "outside", "external-skill");
    mkdirSync(externalSkillDir, { recursive: true });
    writeFileSync(
      join(externalSkillDir, "SKILL.md"),
      '---\nname: "External Skill"\ndescription: "Outside skills root."\n---\n\nDo not load.\n',
    );

    symlinkSync(externalSkillDir, join(TEST_DIR, "skills", "linked-skill"));
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- linked-skill\n");

    const catalog = loadUserSkillCatalog();
    expect(catalog).toHaveLength(0);
  });

  test("rejects symlinked SKILL.md files that point outside ~/.vellum/workspace/skills", () => {
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
    writeFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "- linked-file-skill\n",
    );

    const catalog = loadUserSkillCatalog();
    expect(catalog).toHaveLength(0);
  });

  test("uses SKILLS.md ordering when index exists", () => {
    writeSkill("first", "First Skill", "First");
    writeSkill("second", "Second Skill", "Second");
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- second\n- first\n");

    const catalog = loadUserSkillCatalog();
    expect(catalog.map((skill) => skill.id)).toEqual(["second", "first"]);
  });

  test("falls back to auto-discovery when SKILLS.md is missing", () => {
    writeSkill("zeta", "Zeta Skill", "Zeta");
    writeSkill("alpha", "Alpha Skill", "Alpha");

    const catalog = loadUserSkillCatalog();
    expect(catalog.map((skill) => skill.id)).toEqual(["alpha", "zeta"]);
  });

  test("treats SKILLS.md as authoritative when present", () => {
    writeSkill("available", "Available Skill", "Present on disk");
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- ../invalid-only\n");

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
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
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
});

describe("tool manifest detection", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
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
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
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
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- parent\n");
    const catalog = loadUserSkillCatalog();
    const skill = catalog.find((s) => s.id === "parent");
    expect(skill).toBeDefined();
    expect(skill!.includes).toEqual(["child-a", "child-b"]);
  });

  test("trims whitespace in includes entries", () => {
    writeSkillWithIncludes("parent", '["  child-a  ", " child-b "]');
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- parent\n");
    const catalog = loadUserSkillCatalog();
    const skill = catalog.find((s) => s.id === "parent");
    expect(skill!.includes).toEqual(["child-a", "child-b"]);
  });

  test("removes empty strings from includes", () => {
    writeSkillWithIncludes("parent", '["child-a", "", "  ", "child-b"]');
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- parent\n");
    const catalog = loadUserSkillCatalog();
    const skill = catalog.find((s) => s.id === "parent");
    expect(skill!.includes).toEqual(["child-a", "child-b"]);
  });

  test("deduplicates includes preserving first-seen order", () => {
    writeSkillWithIncludes("parent", '["child-a", "child-b", "child-a"]');
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- parent\n");
    const catalog = loadUserSkillCatalog();
    const skill = catalog.find((s) => s.id === "parent");
    expect(skill!.includes).toEqual(["child-a", "child-b"]);
  });

  test("returns undefined for invalid JSON", () => {
    writeSkillWithIncludes("parent", "not-json");
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- parent\n");
    const catalog = loadUserSkillCatalog();
    const skill = catalog.find((s) => s.id === "parent");
    expect(skill!.includes).toBeUndefined();
  });

  test("returns undefined for non-array JSON", () => {
    writeSkillWithIncludes("parent", '"just-a-string"');
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- parent\n");
    const catalog = loadUserSkillCatalog();
    const skill = catalog.find((s) => s.id === "parent");
    expect(skill!.includes).toBeUndefined();
  });

  test("returns undefined for array with non-string elements", () => {
    writeSkillWithIncludes("parent", "[123, true]");
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- parent\n");
    const catalog = loadUserSkillCatalog();
    const skill = catalog.find((s) => s.id === "parent");
    expect(skill!.includes).toBeUndefined();
  });

  test("returns undefined for empty array", () => {
    writeSkillWithIncludes("parent", "[]");
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- parent\n");
    const catalog = loadUserSkillCatalog();
    const skill = catalog.find((s) => s.id === "parent");
    expect(skill!.includes).toBeUndefined();
  });

  test("skill without includes has undefined includes", () => {
    writeSkill("no-includes", "No Includes", "Test");
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- no-includes\n");
    const catalog = loadUserSkillCatalog();
    const skill = catalog.find((s) => s.id === "no-includes");
    expect(skill!.includes).toBeUndefined();
  });
});

describe("bundled browser skill", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test("browser skill appears in full catalog (including bundled)", () => {
    const catalog = loadSkillCatalog();
    const browserSkill = catalog.find((s) => s.id === "browser");
    expect(browserSkill).toBeDefined();
    expect(browserSkill!.name).toBe("browser");
    expect(browserSkill!.displayName).toBe("Browser");
    expect(browserSkill!.bundled).toBe(true);
  });

  test("browser skill has correct metadata", () => {
    const catalog = loadSkillCatalog();
    const browserSkill = catalog.find((s) => s.id === "browser");
    expect(browserSkill).toBeDefined();
    expect(browserSkill!.description).toBe(
      "Navigate and interact with web pages using a headless browser",
    );
  });

  test("browser skill is user-invocable", () => {
    const catalog = loadSkillCatalog();
    const browserSkill = catalog.find((s) => s.id === "browser");
    expect(browserSkill).toBeDefined();
    expect(browserSkill!.userInvocable).toBe(true);
  });

  test("browser skill has model invocation enabled", () => {
    const catalog = loadSkillCatalog();
    const browserSkill = catalog.find((s) => s.id === "browser");
    expect(browserSkill).toBeDefined();
    expect(browserSkill!.disableModelInvocation).toBe(false);
  });

  test("browser skill has a valid tool manifest with 14 tools", () => {
    const catalog = loadSkillCatalog();
    const browserSkill = catalog.find((s) => s.id === "browser");
    expect(browserSkill).toBeDefined();
    expect(browserSkill!.toolManifest).toBeDefined();
    expect(browserSkill!.toolManifest!.present).toBe(true);
    expect(browserSkill!.toolManifest!.valid).toBe(true);
    expect(browserSkill!.toolManifest!.toolCount).toBe(14);
    expect(browserSkill!.toolManifest!.toolNames).toEqual([
      "browser_navigate",
      "browser_snapshot",
      "browser_screenshot",
      "browser_close",
      "browser_click",
      "browser_type",
      "browser_press_key",
      "browser_scroll",
      "browser_select_option",
      "browser_hover",
      "browser_wait_for",
      "browser_extract",
      "browser_wait_for_download",
      "browser_fill_credential",
    ]);
  });
});

describe("ingress-dependent setup skills declare public-ingress", () => {
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

  test("telegram-setup includes public-ingress", () => {
    const includes = readSkillIncludes(
      FIRST_PARTY_SKILLS_DIR,
      "telegram-setup",
    );
    expect(includes).toBeDefined();
    expect(includes).toContain("public-ingress");
  });

  test("google-oauth-setup includes public-ingress", () => {
    const includes = readSkillIncludes(
      FIRST_PARTY_SKILLS_DIR,
      "google-oauth-setup",
    );
    expect(includes).toBeDefined();
    expect(includes).toContain("public-ingress");
  });

  test("slack-oauth-setup includes browser", () => {
    const includes = readSkillIncludes(
      FIRST_PARTY_SKILLS_DIR,
      "slack-oauth-setup",
    );
    expect(includes).toBeDefined();
    expect(includes).toContain("browser");
  });
});

describe("bundled computer-use skill", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test("computer-use skill appears in full catalog (including bundled)", () => {
    const catalog = loadSkillCatalog();
    const cuSkill = catalog.find((s) => s.id === "computer-use");
    expect(cuSkill).toBeDefined();
    expect(cuSkill!.name).toBe("computer-use");
    expect(cuSkill!.displayName).toBe("Computer Use");
    expect(cuSkill!.bundled).toBe(true);
  });

  test("computer-use skill is not user-invocable", () => {
    const catalog = loadSkillCatalog();
    const cuSkill = catalog.find((s) => s.id === "computer-use");
    expect(cuSkill).toBeDefined();
    expect(cuSkill!.userInvocable).toBe(false);
  });

  test("computer-use skill has model invocation disabled", () => {
    const catalog = loadSkillCatalog();
    const cuSkill = catalog.find((s) => s.id === "computer-use");
    expect(cuSkill).toBeDefined();
    expect(cuSkill!.disableModelInvocation).toBe(true);
  });

  test("computer-use skill has a valid tool manifest with 12 tools", () => {
    const catalog = loadSkillCatalog();
    const cuSkill = catalog.find((s) => s.id === "computer-use");
    expect(cuSkill).toBeDefined();
    expect(cuSkill!.toolManifest).toBeDefined();
    expect(cuSkill!.toolManifest!.present).toBe(true);
    expect(cuSkill!.toolManifest!.valid).toBe(true);
    expect(cuSkill!.toolManifest!.toolCount).toBe(12);
    expect(cuSkill!.toolManifest!.toolNames).toEqual([
      "computer_use_click",
      "computer_use_double_click",
      "computer_use_right_click",
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
