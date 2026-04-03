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
  readSkillVersion,
  removeSkillsIndexEntry,
  upsertSkillsIndexEntry,
  validateManagedSkillId,
} from "../skills/managed-store.js";

beforeEach(() => {
  mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
});

afterEach(() => {
  rmSync(join(TEST_DIR, "skills"), { recursive: true, force: true });
});

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
    const catalog = loadSkillCatalog(undefined, [join(TEST_DIR, "skills")]);
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

    const catalog = loadSkillCatalog(undefined, [join(TEST_DIR, "skills")]);
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

  test("omits metadata when no vellum fields provided", () => {
    const result = buildSkillMarkdown({
      name: "Solo",
      description: "No children",
      bodyMarkdown: "Body.",
    });
    expect(result).not.toContain("metadata:");
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

    const catalog = loadSkillCatalog(undefined, [join(TEST_DIR, "skills")]);
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

describe("SKILLS.md index management", () => {
  test("SKILLS.md is created when absent", () => {
    upsertSkillsIndexEntry("my-skill");
    const indexPath = join(TEST_DIR, "skills", "SKILLS.md");
    expect(existsSync(indexPath)).toBe(true);
    const content = readFileSync(indexPath, "utf-8");
    expect(content).toContain("- my-skill");
  });

  test("index add is idempotent", () => {
    upsertSkillsIndexEntry("my-skill");
    upsertSkillsIndexEntry("my-skill");
    const content = readFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "utf-8",
    );
    const matches = content.match(/- my-skill/g);
    expect(matches?.length).toBe(1);
  });

  test("delete removes directory and index entry", () => {
    // Set up a skill
    const skillDir = join(TEST_DIR, "skills", "doomed");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "test");
    writeFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "- doomed\n- survivor\n",
    );

    const result = deleteManagedSkill("doomed");
    expect(result.deleted).toBe(true);
    expect(result.indexUpdated).toBe(true);
    expect(existsSync(skillDir)).toBe(false);

    const content = readFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "utf-8",
    );
    expect(content).not.toContain("doomed");
    expect(content).toContain("survivor");
  });

  test("upsert recognizes * bullet entries", () => {
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "* existing-skill\n");
    upsertSkillsIndexEntry("existing-skill");
    const content = readFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "utf-8",
    );
    const matches = content.match(/existing-skill/g);
    expect(matches?.length).toBe(1);
  });

  test("remove handles * bullet entries", () => {
    writeFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "* doomed\n- survivor\n",
    );
    removeSkillsIndexEntry("doomed");
    const content = readFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "utf-8",
    );
    expect(content).not.toContain("doomed");
    expect(content).toContain("survivor");
  });

  test("remove handles markdown link entries", () => {
    writeFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "- [My Skill](my-skill/SKILL.md)\n- survivor\n",
    );
    removeSkillsIndexEntry("my-skill");
    const content = readFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "utf-8",
    );
    expect(content).not.toContain("my-skill");
    expect(content).toContain("survivor");
  });

  test("upsert recognizes markdown link entries as existing", () => {
    writeFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "- [My Skill](my-skill/SKILL.md)\n",
    );
    upsertSkillsIndexEntry("my-skill");
    const content = readFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "utf-8",
    );
    const matches = content.match(/my-skill/g);
    expect(matches?.length).toBe(1);
  });

  test("remove from index handles missing entry gracefully", () => {
    writeFileSync(join(TEST_DIR, "skills", "SKILLS.md"), "- other-skill\n");
    removeSkillsIndexEntry("nonexistent");
    const content = readFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "utf-8",
    );
    expect(content).toContain("other-skill");
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

  test("updates SKILLS.md index", () => {
    createManagedSkill({
      id: "indexed-skill",
      name: "Indexed",
      description: "Gets indexed",
      bodyMarkdown: "Body.",
    });

    const indexContent = readFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "utf-8",
    );
    expect(indexContent).toContain("- indexed-skill");
  });

  test("skips index when addToIndex=false", () => {
    createManagedSkill({
      id: "no-index",
      name: "No Index",
      description: "Not indexed",
      bodyMarkdown: "Body.",
      addToIndex: false,
    });

    const indexPath = join(TEST_DIR, "skills", "SKILLS.md");
    if (existsSync(indexPath)) {
      const content = readFileSync(indexPath, "utf-8");
      expect(content).not.toContain("no-index");
    }
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

  test("skips index removal when removeFromIndex=false", () => {
    createManagedSkill({
      id: "keep-index",
      name: "Keep Index",
      description: "Index stays",
      bodyMarkdown: "Body.",
    });

    const result = deleteManagedSkill("keep-index", false);
    expect(result.deleted).toBe(true);
    expect(result.indexUpdated).toBe(false);

    const indexContent = readFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "utf-8",
    );
    expect(indexContent).toContain("- keep-index");
  });

  test("succeeds even when index cleanup throws", () => {
    createManagedSkill({
      id: "index-fail",
      name: "Index Fail",
      description: "Index removal will throw",
      bodyMarkdown: "Body.",
    });

    // Intercept the atomic write (.tmp- file) used by removeSkillsIndexEntry
    const skillsDir = join(TEST_DIR, "skills");
    const originalWrite = fs.writeFileSync;
    const spy = spyOn(fs, "writeFileSync").mockImplementation(((
      path: fs.PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      options?: fs.WriteFileOptions,
    ) => {
      if (
        typeof path === "string" &&
        path.startsWith(skillsDir) &&
        path.includes(".tmp-")
      ) {
        throw new Error("Simulated write failure");
      }
      return originalWrite(path, data, options);
    }) as typeof fs.writeFileSync);

    try {
      const result = deleteManagedSkill("index-fail");
      expect(result.deleted).toBe(true);
      expect(result.indexUpdated).toBe(false);
      expect(existsSync(join(skillsDir, "index-fail"))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("version metadata", () => {
  test("readSkillVersion returns null for non-existent skill", () => {
    expect(readSkillVersion("nonexistent")).toBeNull();
  });

  test("readSkillVersion returns null when skill exists but has no version.json", () => {
    createManagedSkill({
      id: "no-version",
      name: "No Version",
      description: "Created without version",
      bodyMarkdown: "Body.",
    });
    expect(readSkillVersion("no-version")).toBeNull();
  });

  test("createManagedSkill writes install-meta.json when version is provided", () => {
    createManagedSkill({
      id: "versioned",
      name: "Versioned",
      description: "Has a version",
      bodyMarkdown: "Body.",
      version: "v1:abc123",
    });

    const version = readSkillVersion("versioned");
    expect(version).toBe("v1:abc123");
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
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    expect(meta.origin).toBe("custom");
    expect(meta.version).toBe("v1:deadbeef");
    expect(typeof meta.installedAt).toBe("string");
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
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    expect(meta.origin).toBe("custom");
    expect(meta.installedBy).toBe("contact-uuid-456");
  });

  test("overwrite updates install-meta.json", () => {
    createManagedSkill({
      id: "update-version",
      name: "V1",
      description: "First",
      bodyMarkdown: "Body.",
      version: "v1:first",
    });
    expect(readSkillVersion("update-version")).toBe("v1:first");

    createManagedSkill({
      id: "update-version",
      name: "V2",
      description: "Second",
      bodyMarkdown: "Body.",
      version: "v1:second",
      overwrite: true,
    });
    expect(readSkillVersion("update-version")).toBe("v1:second");
  });

  test("readSkillVersion returns null for corrupted install-meta.json", () => {
    createManagedSkill({
      id: "corrupt-version",
      name: "Corrupt",
      description: "Will corrupt meta file",
      bodyMarkdown: "Body.",
      version: "v1:valid",
    });

    // Corrupt the install-meta.json
    const metaPath = join(
      TEST_DIR,
      "skills",
      "corrupt-version",
      "install-meta.json",
    );
    writeFileSync(metaPath, "{invalid json!!!", "utf-8");

    expect(readSkillVersion("corrupt-version")).toBeNull();
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
