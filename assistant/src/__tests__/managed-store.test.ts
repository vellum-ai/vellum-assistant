import * as fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import { parse as parseYaml } from "yaml";

const TEST_DIR = process.env.VELLUM_WORKSPACE_DIR!;

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { loadSkillCatalog } from "../config/skills.js";
import {
  buildSkillMarkdown,
  createManagedSkill,
  deleteManagedSkill,
  validateCompanionPath,
  validateManagedSkillId,
} from "../skills/managed-store.js";

beforeEach(() => {
  mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
});

afterEach(() => {
  rmSync(join(TEST_DIR, "skills"), { recursive: true, force: true });
});

interface TestInstallMeta {
  origin?: string;
  version?: string;
  installedAt?: string;
  installedBy?: string;
  author?: string;
}

function readInstallMetaFile(skillId: string): TestInstallMeta {
  return JSON.parse(
    readFileSync(
      join(TEST_DIR, "skills", skillId, "install-meta.json"),
      "utf-8",
    ),
  );
}

describe("validateManagedSkillId", () => {
  test("accepts valid slug IDs", () => {
    expect(validateManagedSkillId("my-skill")).toBeNull();
    expect(validateManagedSkillId("skill123")).toBeNull();
    expect(validateManagedSkillId("my.skill")).toBeNull();
    expect(validateManagedSkillId("my_skill")).toBeNull();
  });

  test("rejects empty string", () => {
    expect(validateManagedSkillId("")).not.toBeNull();
  });

  test("rejects traversal patterns", () => {
    expect(validateManagedSkillId("../escape")).not.toBeNull();
    expect(validateManagedSkillId("foo/bar")).not.toBeNull();
    expect(validateManagedSkillId("foo\\bar")).not.toBeNull();
  });

  test("rejects uppercase", () => {
    expect(validateManagedSkillId("MySkill")).not.toBeNull();
  });

  test("rejects IDs starting with special chars", () => {
    expect(validateManagedSkillId(".hidden")).not.toBeNull();
    expect(validateManagedSkillId("-dash")).not.toBeNull();
  });
});

describe("buildSkillMarkdown", () => {
  test("generates valid frontmatter and body", () => {
    const result = buildSkillMarkdown({
      name: "Test Skill",
      description: "A test skill",
      bodyMarkdown: "Do the thing.",
    });
    expect(result).toContain("---\n");
    expect(result).toContain('name: "Test Skill"');
    expect(result).toContain('description: "A test skill"');
    expect(result).toContain("Do the thing.");
    expect(result.endsWith("\n")).toBe(true);
  });

  test("includes optional emoji in metadata.vellum", () => {
    const result = buildSkillMarkdown({
      name: "Emoji Skill",
      description: "Has an emoji",
      bodyMarkdown: "Body.",
      emoji: "🧪",
    });
    expect(result).toContain("metadata:");
    const fmMatch = result.match(/^---\n([\s\S]*?)\n---/);
    const parsed = parseYaml(fmMatch![1]);
    expect(parsed.metadata.vellum.emoji).toBe("🧪");
  });

  test("escapes double quotes in name and description", () => {
    const result = buildSkillMarkdown({
      name: 'Say "hi"',
      description: 'A "quoted" desc',
      bodyMarkdown: "Body.",
    });
    expect(result).toContain('name: "Say \\"hi\\""');
    expect(result).toContain('description: "A \\"quoted\\" desc"');
  });

  test("escapes newlines in name and description", () => {
    const result = buildSkillMarkdown({
      name: "Line1\nLine2",
      description: "Desc\nMulti",
      bodyMarkdown: "Body.",
    });
    expect(result).toContain('name: "Line1\\nLine2"');
    expect(result).toContain('description: "Desc\\nMulti"');
  });

  test("escapes backslashes in name", () => {
    const result = buildSkillMarkdown({
      name: "back\\slash",
      description: "ok",
      bodyMarkdown: "Body.",
    });
    expect(result).toContain('name: "back\\\\slash"');
  });

  test("round-trips special characters through write and load", () => {
    // Write a skill with special chars in name/description
    createManagedSkill({
      id: "roundtrip-test",
      name: 'Say "hello" & back\\slash',
      description: "Line1\nLine2\r\nLine3",
      bodyMarkdown: "Body content.",
    });

    // Load it back via loadSkillCatalog (which uses parseFrontmatter)
    const catalog = loadSkillCatalog();
    const skill = catalog.find((s) => s.id === "roundtrip-test");
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('Say "hello" & back\\slash');
    expect(skill!.description).toBe("Line1\nLine2\r\nLine3");
  });

  test("round-trips backslash-n literal (not a newline) correctly", () => {
    // A name containing a literal backslash followed by 'n' (not a newline)
    const nameWithBackslashN = "path\\name";
    createManagedSkill({
      id: "backslash-n-test",
      name: nameWithBackslashN,
      description: "test",
      bodyMarkdown: "Body.",
    });

    const catalog = loadSkillCatalog();
    const skill = catalog.find((s) => s.id === "backslash-n-test");
    expect(skill).toBeDefined();
    expect(skill!.name).toBe("path\\name");
  });

  test("includes field emits YAML list in metadata.vellum", () => {
    const result = buildSkillMarkdown({
      name: "Parent",
      description: "Has children",
      bodyMarkdown: "Body.",
      includes: ["child-a", "child-b"],
    });
    const fmMatch = result.match(/^---\n([\s\S]*?)\n---/);
    const parsed = parseYaml(fmMatch![1]);
    expect(parsed.metadata.vellum.includes).toEqual(["child-a", "child-b"]);
  });

  test("activation-hints and avoid-when emit kebab-case YAML lists in metadata.vellum", () => {
    const result = buildSkillMarkdown({
      name: "Hinted Skill",
      description: "Has trigger phrases",
      bodyMarkdown: "Body.",
      activationHints: ["user asks to deploy staging", "needs a release cut"],
      avoidWhen: ["local-only changes"],
    });
    const fmMatch = result.match(/^---\n([\s\S]*?)\n---/);
    const parsed = parseYaml(fmMatch![1]);
    // Kebab-case keys are what parseFrontmatter reads back (config/skills.ts).
    expect(parsed.metadata.vellum["activation-hints"]).toEqual([
      "user asks to deploy staging",
      "needs a release cut",
    ]);
    expect(parsed.metadata.vellum["avoid-when"]).toEqual([
      "local-only changes",
    ]);
  });

  test("omits activation-hints / avoid-when when empty and no other vellum fields", () => {
    const result = buildSkillMarkdown({
      name: "Empty Hints",
      description: "Empty arrays",
      bodyMarkdown: "Body.",
      activationHints: [],
      avoidWhen: [],
    });
    expect(result).not.toContain("metadata:");
  });

  test("includes optional category in metadata.vellum", () => {
    const result = buildSkillMarkdown({
      name: "Categorized Skill",
      description: "Has a category",
      bodyMarkdown: "Body.",
      category: "development",
    });
    const fmMatch = result.match(/^---\n([\s\S]*?)\n---/);
    const parsed = parseYaml(fmMatch![1]);
    expect(parsed.metadata.vellum.category).toBe("development");
  });

  test("omits metadata when no vellum fields provided", () => {
    const result = buildSkillMarkdown({
      name: "Solo",
      description: "No children",
      bodyMarkdown: "Body.",
    });
    expect(result).not.toContain("metadata:");
  });

  test("omits category when blank or whitespace-only", () => {
    expect(
      buildSkillMarkdown({
        name: "Blank Category",
        description: "Blank",
        bodyMarkdown: "Body.",
        category: "   ",
      }),
    ).not.toContain("metadata:");
  });

  test("omits metadata when includes is empty array and no other vellum fields", () => {
    const result = buildSkillMarkdown({
      name: "Empty",
      description: "Empty array",
      bodyMarkdown: "Body.",
      includes: [],
    });
    expect(result).not.toContain("metadata:");
  });

  test("includes round-trips through write and catalog load", () => {
    createManagedSkill({
      id: "roundtrip-includes",
      name: "Roundtrip",
      description: "Test roundtrip",
      bodyMarkdown: "Body.",
      includes: ["child-x", "child-y"],
    });

    const catalog = loadSkillCatalog();
    const skill = catalog.find((s) => s.id === "roundtrip-includes");
    expect(skill).toBeDefined();
    expect(skill!.includes).toEqual(["child-x", "child-y"]);
  });

  test("single-quoted frontmatter preserves backslashes literally", () => {
    // Single-quoted YAML values treat backslashes as literal characters.
    // Manually write a SKILL.md with single-quoted frontmatter to simulate
    // a hand-authored skill file.
    const skillDir = join(TEST_DIR, "skills", "single-quote-test");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: 'path\\\\name'\ndescription: 'has \\n in it'\n---\n\nBody.\n",
    );

    const catalog = loadSkillCatalog(undefined, [join(TEST_DIR, "skills")]);
    const skill = catalog.find((s) => s.id === "single-quote-test");
    expect(skill).toBeDefined();
    // Backslashes should be preserved literally, not interpreted as escape sequences
    expect(skill!.name).toBe("path\\\\name");
    expect(skill!.description).toBe("has \\n in it");
  });
});

describe("createManagedSkill", () => {
  test("creates skill and writes to expected path", () => {
    const result = createManagedSkill({
      id: "test-skill",
      name: "Test Skill",
      description: "A test skill",
      bodyMarkdown: "Instructions here.",
    });

    expect(result.created).toBe(true);
    expect(result.error).toBeUndefined();
    expect(existsSync(result.path)).toBe(true);

    const content = readFileSync(result.path, "utf-8");
    expect(content).toContain('name: "Test Skill"');
    expect(content).toContain("Instructions here.");
  });

  test("rejects duplicate unless overwrite=true", () => {
    createManagedSkill({
      id: "dupe",
      name: "Original",
      description: "First version",
      bodyMarkdown: "V1.",
    });

    const result2 = createManagedSkill({
      id: "dupe",
      name: "Duplicate",
      description: "Second version",
      bodyMarkdown: "V2.",
    });
    expect(result2.created).toBe(false);
    expect(result2.error).toContain("already exists");

    const result3 = createManagedSkill({
      id: "dupe",
      name: "Overwritten",
      description: "Third version",
      bodyMarkdown: "V3.",
      overwrite: true,
    });
    expect(result3.created).toBe(true);
    const content = readFileSync(result3.path, "utf-8");
    expect(content).toContain("Overwritten");
  });

  test("writes category to frontmatter and round-trips through catalog load", () => {
    createManagedSkill({
      id: "categorized-skill",
      name: "Categorized",
      description: "Has a category",
      bodyMarkdown: "Body.",
      category: "development",
    });

    const content = readFileSync(
      join(TEST_DIR, "skills", "categorized-skill", "SKILL.md"),
      "utf-8",
    );
    expect(content).toContain("category: development");

    const catalog = loadSkillCatalog(undefined, [join(TEST_DIR, "skills")]);
    const skill = catalog.find((s) => s.id === "categorized-skill");
    expect(skill).toBeDefined();
    expect(skill!.category).toBe("development");
  });

  test("leaves category unset when omitted", () => {
    createManagedSkill({
      id: "no-category",
      name: "No Category",
      description: "Uncategorized",
      bodyMarkdown: "Body.",
    });

    const catalog = loadSkillCatalog(undefined, [join(TEST_DIR, "skills")]);
    const skill = catalog.find((s) => s.id === "no-category");
    expect(skill).toBeDefined();
    expect(skill!.category).toBeUndefined();
  });

  test("rejects invalid IDs", () => {
    const result = createManagedSkill({
      id: "../escape",
      name: "Bad",
      description: "Bad",
      bodyMarkdown: "Bad.",
    });
    expect(result.created).toBe(false);
    expect(result.error).toContain("traversal");
  });

  test("rejects empty name", () => {
    const result = createManagedSkill({
      id: "no-name",
      name: "",
      description: "Has desc",
      bodyMarkdown: "Body.",
    });
    expect(result.created).toBe(false);
    expect(result.error).toContain("name is required");
  });

  test("rejects whitespace-only name", () => {
    const result = createManagedSkill({
      id: "blank-name",
      name: "   ",
      description: "Has desc",
      bodyMarkdown: "Body.",
    });
    expect(result.created).toBe(false);
    expect(result.error).toContain("name is required");
  });

  test("rejects empty description", () => {
    const result = createManagedSkill({
      id: "no-desc",
      name: "Has Name",
      description: "",
      bodyMarkdown: "Body.",
    });
    expect(result.created).toBe(false);
    expect(result.error).toContain("description is required");
  });

  test("does not create SKILLS.md and is discovered through SKILL.md directory", () => {
    createManagedSkill({
      id: "discovered-skill",
      name: "Discovered",
      description: "Found by directory discovery",
      bodyMarkdown: "Body.",
    });

    expect(existsSync(join(TEST_DIR, "skills", "SKILLS.md"))).toBe(false);

    const catalog = loadSkillCatalog(undefined, [join(TEST_DIR, "skills")]);
    const skill = catalog.find((s) => s.id === "discovered-skill");
    expect(skill).toBeDefined();
    expect(skill!.name).toBe("Discovered");
  });
});

describe("validateCompanionPath", () => {
  const skillDir = "/workspace/skills/my-skill";

  test("accepts a nested relative path", () => {
    const result = validateCompanionPath(
      skillDir,
      "references/failure-modes.md",
    );
    expect(result.error).toBeUndefined();
    expect(result.resolvedPath).toBe(
      join(skillDir, "references", "failure-modes.md"),
    );
  });

  test("rejects absolute paths", () => {
    expect(validateCompanionPath(skillDir, "/etc/passwd").error).toContain(
      "relative",
    );
  });

  test("rejects traversal with leading ..", () => {
    expect(
      validateCompanionPath(skillDir, "../sibling/evil.md").error,
    ).toContain("..");
  });

  test("rejects traversal in a middle segment", () => {
    expect(
      validateCompanionPath(skillDir, "references/../../escape.md").error,
    ).toContain("..");
  });

  test("rejects empty path", () => {
    expect(validateCompanionPath(skillDir, "").error).not.toBeUndefined();
  });

  test("rejects path resolving to the skill dir itself", () => {
    expect(validateCompanionPath(skillDir, ".").error).not.toBeUndefined();
  });

  test("rejects store-owned top-level files", () => {
    for (const reserved of [
      "SKILL.md",
      "install-meta.json",
      "version.json",
      "TOOLS.json",
    ]) {
      expect(validateCompanionPath(skillDir, reserved).error).toContain(
        "store-owned",
      );
    }
    // The same name nested under a subdirectory is allowed (only top-level reserved).
    expect(
      validateCompanionPath(skillDir, "references/SKILL.md").error,
    ).toBeUndefined();
  });

  test("rejects a top-level TOOLS.json companion to block planting executable tools", () => {
    // TOOLS.json is the manifest the skill loader scans to register (and
    // dynamically import) executable tools. A scaffold author must never be
    // able to plant one — otherwise an instruction-only managed skill becomes a
    // code-injection surface.
    expect(validateCompanionPath(skillDir, "TOOLS.json").error).toContain(
      "store-owned",
    );
  });

  test("rejects case variants of reserved names (case-insensitive filesystems)", () => {
    // On macOS (case-insensitive FS), `tools.json` resolves to the same file
    // the scanner reads as `TOOLS.json`, so a varied-case name must be rejected
    // too — otherwise the guard is trivially bypassed. Same for SKILL.md.
    for (const variant of [
      "tools.json",
      "Tools.json",
      "TOOLS.JSON",
      "skill.md",
      "Skill.MD",
      "INSTALL-META.JSON",
    ]) {
      expect(validateCompanionPath(skillDir, variant).error).toContain(
        "store-owned",
      );
    }
    // Nested case variants remain allowed — only top-level is scanned.
    expect(
      validateCompanionPath(skillDir, "references/tools.json").error,
    ).toBeUndefined();
  });
});

describe("createManagedSkill companion files", () => {
  test("writes companion files under the skill dir and round-trips on disk", () => {
    const result = createManagedSkill({
      id: "with-files",
      name: "With Files",
      description: "Has companion files",
      bodyMarkdown: "See references/failure-modes.md.",
      files: [
        {
          path: "references/failure-modes.md",
          content: "# Failure modes\n\nThings that break.\n",
        },
      ],
    });

    expect(result.created).toBe(true);
    const companionPath = join(
      TEST_DIR,
      "skills",
      "with-files",
      "references",
      "failure-modes.md",
    );
    expect(existsSync(companionPath)).toBe(true);
    expect(readFileSync(companionPath, "utf-8")).toBe(
      "# Failure modes\n\nThings that break.\n",
    );
  });

  test("rejects a companion path colliding with an existing directory on overwrite, leaving SKILL.md intact", () => {
    const first = createManagedSkill({
      id: "dir-collide",
      name: "Dir Collide",
      description: "v1",
      bodyMarkdown: "Body v1.",
      files: [{ path: "references/note.md", content: "note" }],
    });
    expect(first.created).toBe(true);
    const skillMd = join(TEST_DIR, "skills", "dir-collide", "SKILL.md");
    const before = readFileSync(skillMd, "utf-8");

    // Overwrite with a companion path that names the existing references/ dir.
    const second = createManagedSkill({
      id: "dir-collide",
      name: "Dir Collide",
      description: "v2",
      bodyMarkdown: "Body v2.",
      overwrite: true,
      files: [{ path: "references", content: "clobber" }],
    });

    expect(second.created).toBe(false);
    expect(second.error).toContain("existing directory");
    // The pre-flight runs before any write, so SKILL.md is untouched.
    expect(readFileSync(skillMd, "utf-8")).toBe(before);
  });

  test("rejects path traversal and writes nothing", () => {
    const result = createManagedSkill({
      id: "traversal",
      name: "Traversal",
      description: "Bad companion path",
      bodyMarkdown: "Body.",
      files: [{ path: "../escape.md", content: "owned" }],
    });

    expect(result.created).toBe(false);
    expect(result.error).toContain("..");
    // No SKILL.md written, no escaped file written.
    expect(existsSync(join(TEST_DIR, "skills", "traversal", "SKILL.md"))).toBe(
      false,
    );
    expect(existsSync(join(TEST_DIR, "skills", "escape.md"))).toBe(false);
  });

  test("rejects absolute companion paths and writes nothing", () => {
    const result = createManagedSkill({
      id: "abs-path",
      name: "Absolute",
      description: "Absolute companion path",
      bodyMarkdown: "Body.",
      files: [{ path: "/tmp/evil.md", content: "owned" }],
    });

    expect(result.created).toBe(false);
    expect(result.error).toContain("relative");
    expect(existsSync(join(TEST_DIR, "skills", "abs-path", "SKILL.md"))).toBe(
      false,
    );
  });

  test("rejects a path resolving outside the skill dir and writes nothing", () => {
    const result = createManagedSkill({
      id: "outside",
      name: "Outside",
      description: "Resolves outside",
      bodyMarkdown: "Body.",
      files: [
        { path: "ok.md", content: "ok" },
        { path: "nested/../../sneaky.md", content: "owned" },
      ],
    });

    expect(result.created).toBe(false);
    expect(result.error).not.toBeUndefined();
    // First file must not be written because validation runs before any write.
    expect(existsSync(join(TEST_DIR, "skills", "outside", "ok.md"))).toBe(
      false,
    );
    expect(existsSync(join(TEST_DIR, "skills", "outside", "SKILL.md"))).toBe(
      false,
    );
  });

  test("does not write companion files when create errors on an existing skill", () => {
    createManagedSkill({
      id: "exists-files",
      name: "Exists",
      description: "Already here",
      bodyMarkdown: "Body.",
    });

    const result = createManagedSkill({
      id: "exists-files",
      name: "Exists Again",
      description: "Should not write",
      bodyMarkdown: "Body.",
      files: [{ path: "references/new.md", content: "new" }],
    });

    expect(result.created).toBe(false);
    expect(result.error).toContain("already exists");
    expect(
      existsSync(
        join(TEST_DIR, "skills", "exists-files", "references", "new.md"),
      ),
    ).toBe(false);
  });

  test("rejects a TOOLS.json companion and writes nothing", () => {
    // Planting a TOOLS.json declaring execution_target/risk would let a
    // scaffolded skill register attacker-controlled tools. The reserved-name
    // check must reject it before any write, leaving no SKILL.md or manifest.
    const result = createManagedSkill({
      id: "tools-manifest",
      name: "Tools Manifest",
      description: "Tries to plant a tool manifest",
      bodyMarkdown: "Body.",
      files: [
        {
          path: "TOOLS.json",
          content: JSON.stringify({
            version: 1,
            tools: [
              {
                name: "pwn",
                description: "x",
                category: "x",
                risk: "low",
                input_schema: { type: "object" },
                executor: "tools/pwn.ts",
                execution_target: "host",
              },
            ],
          }),
        },
      ],
    });

    expect(result.created).toBe(false);
    expect(result.error).toContain("store-owned");
    const skillDir = join(TEST_DIR, "skills", "tools-manifest");
    expect(existsSync(join(skillDir, "TOOLS.json"))).toBe(false);
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(false);
  });

  test("overwrite re-writes companion files", () => {
    createManagedSkill({
      id: "overwrite-files",
      name: "V1",
      description: "First",
      bodyMarkdown: "Body.",
      files: [{ path: "references/notes.md", content: "v1 notes" }],
    });

    const companionPath = join(
      TEST_DIR,
      "skills",
      "overwrite-files",
      "references",
      "notes.md",
    );
    expect(readFileSync(companionPath, "utf-8")).toBe("v1 notes");

    const result = createManagedSkill({
      id: "overwrite-files",
      name: "V2",
      description: "Second",
      bodyMarkdown: "Body.",
      overwrite: true,
      files: [{ path: "references/notes.md", content: "v2 notes" }],
    });

    expect(result.created).toBe(true);
    expect(readFileSync(companionPath, "utf-8")).toBe("v2 notes");
  });
});

describe("atomic write safety", () => {
  test("SKILL.md is not partially written on concurrent create", () => {
    // Verify that atomicWriteFile prevents corruption: after creation,
    // the file is always complete (starts with --- and ends with newline)
    const result = createManagedSkill({
      id: "atomic-test",
      name: "Atomic",
      description: "Tests atomic write",
      bodyMarkdown: "Atomic body content.",
    });

    expect(result.created).toBe(true);
    const content = readFileSync(result.path, "utf-8");
    expect(content.startsWith("---\n")).toBe(true);
    expect(content.endsWith("\n")).toBe(true);
    expect(content).toContain("Atomic body content.");
  });

  test("overwrite replaces file atomically (no leftover temp files)", () => {
    createManagedSkill({
      id: "atomic-overwrite",
      name: "V1",
      description: "First",
      bodyMarkdown: "Original.",
    });

    createManagedSkill({
      id: "atomic-overwrite",
      name: "V2",
      description: "Second",
      bodyMarkdown: "Replaced.",
      overwrite: true,
    });

    const skillDir = join(TEST_DIR, "skills", "atomic-overwrite");
    const files = readdirSync(skillDir).sort();
    // SKILL.md and install-meta.json should exist — no .tmp-* leftover files
    expect(files).toEqual(["SKILL.md", "install-meta.json"]);

    const content = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
    expect(content).toContain('name: "V2"');
    expect(content).toContain("Replaced.");
    expect(content).not.toContain("Original.");
  });
});

describe("atomic write failure", () => {
  test("write error prevents skill creation and leaves no partial files", () => {
    const skillsDir = join(TEST_DIR, "skills");
    const targetDir = join(skillsDir, "fail-write");
    mkdirSync(targetDir, { recursive: true });

    // Capture original before spyOn replaces it. This is deterministic
    // regardless of user privileges (unlike chmod 0o555 which fails as root).
    const originalWrite = fs.writeFileSync;
    const spy = spyOn(fs, "writeFileSync").mockImplementation(((
      path: fs.PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      options?: fs.WriteFileOptions,
    ) => {
      if (
        typeof path === "string" &&
        path.startsWith(targetDir) &&
        path.includes(".tmp-")
      ) {
        throw new Error("Simulated write failure");
      }
      return originalWrite(path, data, options);
    }) as typeof fs.writeFileSync);

    try {
      expect(() => {
        createManagedSkill({
          id: "fail-write",
          name: "Should Fail",
          description: "This should not be written",
          bodyMarkdown: "Unreachable.",
        });
      }).toThrow("Simulated write failure");

      // Verify no SKILL.md or temp files were left behind
      const files = readdirSync(targetDir);
      expect(
        files.filter((f) => f.endsWith(".md") || f.startsWith(".tmp-")),
      ).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("deleteManagedSkill", () => {
  test("deletes existing skill", () => {
    createManagedSkill({
      id: "to-delete",
      name: "Delete Me",
      description: "Will be deleted",
      bodyMarkdown: "Gone soon.",
    });

    const result = deleteManagedSkill("to-delete");
    expect(result.deleted).toBe(true);
    expect(existsSync(join(TEST_DIR, "skills", "to-delete"))).toBe(false);

    const catalog = loadSkillCatalog(undefined, [join(TEST_DIR, "skills")]);
    expect(catalog.find((s) => s.id === "to-delete")).toBeUndefined();
  });

  test("returns error for non-existent skill", () => {
    const result = deleteManagedSkill("ghost");
    expect(result.deleted).toBe(false);
    expect(result.error).toContain("not found");
  });

  test("rejects invalid IDs", () => {
    const result = deleteManagedSkill("../bad");
    expect(result.deleted).toBe(false);
    expect(result.error).toContain("traversal");
  });

  test("delete leaves a stale SKILLS.md index unchanged", () => {
    createManagedSkill({
      id: "keep-index",
      name: "Keep Index",
      description: "Index stays",
      bodyMarkdown: "Body.",
    });
    writeFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "- keep-index\n- survivor\n",
    );

    const result = deleteManagedSkill("keep-index");
    expect(result.deleted).toBe(true);

    const indexContent = readFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "utf-8",
    );
    expect(indexContent).toContain("- keep-index");
    expect(indexContent).toContain("- survivor");

    const catalog = loadSkillCatalog(undefined, [join(TEST_DIR, "skills")]);
    expect(catalog.find((s) => s.id === "keep-index")).toBeUndefined();
  });

  test("delete does not create or edit SKILLS.md", () => {
    createManagedSkill({
      id: "delete-no-index",
      name: "Delete No Index",
      description: "No index write",
      bodyMarkdown: "Body.",
    });

    const skillsDir = join(TEST_DIR, "skills");
    const result = deleteManagedSkill("delete-no-index");
    expect(result.deleted).toBe(true);
    expect(existsSync(join(skillsDir, "delete-no-index"))).toBe(false);
    expect(existsSync(join(skillsDir, "SKILLS.md"))).toBe(false);
  });
});

describe("version metadata", () => {
  test("createManagedSkill writes install-meta.json without version when version is omitted", () => {
    createManagedSkill({
      id: "no-version",
      name: "No Version",
      description: "Created without version",
      bodyMarkdown: "Body.",
    });

    const meta = readInstallMetaFile("no-version");
    expect(meta.origin).toBe("custom");
    expect(meta.version).toBeUndefined();
  });

  test("createManagedSkill writes install-meta.json when version is provided", () => {
    createManagedSkill({
      id: "versioned",
      name: "Versioned",
      description: "Has a version",
      bodyMarkdown: "Body.",
      version: "v1:abc123",
    });

    const meta = readInstallMetaFile("versioned");
    expect(meta.version).toBe("v1:abc123");
  });

  test("install-meta.json contains valid JSON with origin, version, and installedAt", () => {
    createManagedSkill({
      id: "version-meta",
      name: "Meta",
      description: "Check metadata shape",
      bodyMarkdown: "Body.",
      version: "v1:deadbeef",
    });

    const metaPath = join(
      TEST_DIR,
      "skills",
      "version-meta",
      "install-meta.json",
    );
    expect(existsSync(metaPath)).toBe(true);
    const meta = readInstallMetaFile("version-meta");
    expect(meta.origin).toBe("custom");
    expect(meta.version).toBe("v1:deadbeef");
    expect(typeof meta.installedAt).toBe("string");
    if (typeof meta.installedAt !== "string") {
      throw new Error("installedAt must be a string");
    }
    // installedAt should be a valid ISO date
    expect(new Date(meta.installedAt).toISOString()).toBe(meta.installedAt);
  });

  test("install-meta.json includes installedBy when contactId is provided", () => {
    createManagedSkill({
      id: "with-contact",
      name: "With Contact",
      description: "Has contactId",
      bodyMarkdown: "Body.",
      contactId: "contact-uuid-456",
    });

    const metaPath = join(
      TEST_DIR,
      "skills",
      "with-contact",
      "install-meta.json",
    );
    expect(existsSync(metaPath)).toBe(true);
    const meta = readInstallMetaFile("with-contact");
    expect(meta.origin).toBe("custom");
    expect(meta.installedBy).toBe("contact-uuid-456");
  });

  test("install-meta.json forwards author when provided", () => {
    createManagedSkill({
      id: "with-author",
      name: "With Author",
      description: "Has author",
      bodyMarkdown: "Body.",
      author: "user",
    });

    expect(readInstallMetaFile("with-author").author).toBe("user");
  });

  test("install-meta.json omits author when not provided", () => {
    createManagedSkill({
      id: "no-author",
      name: "No Author",
      description: "No author",
      bodyMarkdown: "Body.",
    });

    expect(readInstallMetaFile("no-author").author).toBeUndefined();
  });

  test("overwrite updates install-meta.json", () => {
    createManagedSkill({
      id: "update-version",
      name: "V1",
      description: "First",
      bodyMarkdown: "Body.",
      version: "v1:first",
    });

    expect(readInstallMetaFile("update-version").version).toBe("v1:first");

    createManagedSkill({
      id: "update-version",
      name: "V2",
      description: "Second",
      bodyMarkdown: "Body.",
      version: "v1:second",
      overwrite: true,
    });
    expect(readInstallMetaFile("update-version").version).toBe("v1:second");
  });

  test("overwrite removes legacy version.json", () => {
    createManagedSkill({
      id: "legacy-version",
      name: "Legacy",
      description: "Has legacy metadata",
      bodyMarkdown: "Body.",
      version: "v1:first",
    });

    const legacyMetaPath = join(
      TEST_DIR,
      "skills",
      "legacy-version",
      "version.json",
    );
    writeFileSync(legacyMetaPath, '{"version":"legacy"}', "utf-8");
    expect(existsSync(legacyMetaPath)).toBe(true);

    createManagedSkill({
      id: "legacy-version",
      name: "Legacy Updated",
      description: "Has current metadata",
      bodyMarkdown: "Body.",
      version: "v1:second",
      overwrite: true,
    });

    expect(existsSync(legacyMetaPath)).toBe(false);
  });
});

describe("validateManagedSkillId edge cases", () => {
  test("rejects non-string input", () => {
    // @ts-expect-error testing runtime validation
    expect(validateManagedSkillId(null)).not.toBeNull();
    // @ts-expect-error testing runtime validation
    expect(validateManagedSkillId(undefined)).not.toBeNull();
    // @ts-expect-error testing runtime validation
    expect(validateManagedSkillId(123)).not.toBeNull();
  });

  test("rejects IDs with only dots", () => {
    expect(validateManagedSkillId("...")).not.toBeNull();
  });

  test("rejects single dot (hidden dir)", () => {
    expect(validateManagedSkillId(".")).not.toBeNull();
  });

  test("accepts single character ID", () => {
    expect(validateManagedSkillId("a")).toBeNull();
    expect(validateManagedSkillId("0")).toBeNull();
  });

  test("accepts ID with all allowed character types", () => {
    expect(validateManagedSkillId("a1.b2-c3_d4")).toBeNull();
  });
});

describe("YAML metadata round-trip", () => {
  test("all vellum fields round-trip through write and load", () => {
    // Create a managed skill with every vellum metadata field populated
    createManagedSkill({
      id: "yaml-roundtrip-all",
      name: "Full Metadata Skill",
      description: "Tests all vellum fields round-trip correctly",
      bodyMarkdown: "Full metadata body.",
      emoji: "🔬",
      includes: ["child-a", "child-b"],
    });

    // Load it back via loadSkillCatalog
    const catalog = loadSkillCatalog(undefined, [join(TEST_DIR, "skills")]);
    const skill = catalog.find((s) => s.id === "yaml-roundtrip-all");
    expect(skill).toBeDefined();

    // Verify all fields are correctly preserved
    expect(skill!.name).toBe("Full Metadata Skill");
    expect(skill!.description).toBe(
      "Tests all vellum fields round-trip correctly",
    );
    expect(skill!.emoji).toBe("🔬");
    expect(skill!.includes).toEqual(["child-a", "child-b"]);
  });

  test("activation hints and avoid-when round-trip into SkillSummary", () => {
    // This is the gap the change closes: an assistant-authored (retrospective)
    // skill written via createManagedSkill must carry activation hints so the
    // memory seeder emits a "Use when:" clause for it, just like bundled skills.
    createManagedSkill({
      id: "hints-roundtrip",
      name: "Hints Roundtrip",
      description: "Trigger phrases round-trip through write and load",
      bodyMarkdown: "Body.",
      activationHints: ["user asks to deploy staging", "needs a release cut"],
      avoidWhen: ["local-only changes"],
    });

    const catalog = loadSkillCatalog(undefined, [join(TEST_DIR, "skills")]);
    const skill = catalog.find((s) => s.id === "hints-roundtrip");
    expect(skill).toBeDefined();
    expect(skill!.activationHints).toEqual([
      "user asks to deploy staging",
      "needs a release cut",
    ]);
    expect(skill!.avoidWhen).toEqual(["local-only changes"]);
  });

  test("hand-authored YAML nested metadata parses correctly", () => {
    // Manually write a SKILL.md with YAML-style nested metadata matching
    // the format used in skills/ directory (bundled skills format)
    const skillDir = join(TEST_DIR, "skills", "yaml-nested-test");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: yaml-nested-skill",
        "description: Hand-authored YAML nested metadata test",
        'compatibility: "Designed for Vellum personal assistants"',
        "metadata:",
        '  emoji: "🧪"',
        "  vellum:",
        '    display-name: "YAML Nested Skill"',
        "    includes:",
        '      - "child-a"',
        '      - "child-b"',
        "---",
        "",
        "Hand-authored body content.",
        "",
      ].join("\n"),
    );

    const catalog = loadSkillCatalog(undefined, [join(TEST_DIR, "skills")]);
    const skill = catalog.find((s) => s.id === "yaml-nested-test");
    expect(skill).toBeDefined();

    // Verify all nested vellum fields are correctly parsed
    expect(skill!.name).toBe("yaml-nested-skill");
    expect(skill!.description).toBe("Hand-authored YAML nested metadata test");
    expect(skill!.displayName).toBe("YAML Nested Skill");
    expect(skill!.emoji).toBe("🧪");
    expect(skill!.includes).toEqual(["child-a", "child-b"]);
  });
});
