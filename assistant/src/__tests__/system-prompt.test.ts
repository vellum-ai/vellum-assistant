import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Mock platform to use a temp directory
const TEST_DIR = join(tmpdir(), `vellum-sysprompt-test-${crypto.randomUUID()}`);

import { mock } from "bun:test";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realPlatform = require("../util/platform.js");
mock.module("../util/platform.js", () => ({
  ...realPlatform,
  getRootDir: () => TEST_DIR,
  getDataDir: () => TEST_DIR,
  getWorkspaceDir: () => TEST_DIR,
  getWorkspaceConfigPath: () => join(TEST_DIR, "config.json"),
  getWorkspaceSkillsDir: () => join(TEST_DIR, "skills"),
  getWorkspaceHooksDir: () => join(TEST_DIR, "hooks"),
  getWorkspacePromptPath: (file: string) => join(TEST_DIR, file),
  ensureDataDir: () => {},
  getPidPath: () => join(TEST_DIR, "vellum.pid"),
  getDbPath: () => join(TEST_DIR, "data", "assistant.db"),
  getLogPath: () => join(TEST_DIR, "logs", "vellum.log"),
  getHistoryPath: () => join(TEST_DIR, "history"),
  getHooksDir: () => join(TEST_DIR, "hooks"),

  getSandboxRootDir: () => join(TEST_DIR, "sandbox"),
  getSandboxWorkingDir: () => TEST_DIR,
  getInterfacesDir: () => join(TEST_DIR, "interfaces"),
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPlatformName: () => process.platform,
  getClipboardCommand: () => null,
  readSessionToken: () => null,
}));

const noopLogger: Record<string, unknown> = new Proxy(
  {} as Record<string, unknown>,
  {
    get: (_target, prop) => (prop === "child" ? () => noopLogger : () => {}),
  },
);

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

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    services: {
      inference: {
        mode: "your-own",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": { mode: "your-own", provider: "anthropic-native" },
    },
  }),
  loadConfig: () => ({}),
  loadRawConfig: () => ({}),
  saveConfig: () => {},
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
  syncConfigToLockfile: () => {},
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realUserReference = require("../prompts/user-reference.js");
mock.module("../prompts/user-reference.js", () => ({
  ...realUserReference,
  resolveUserReference: () => "John",
  resolveUserPronouns: () => null,
}));

// Import after mock
const {
  buildSystemPrompt,
  ensurePromptFiles,
  stripCommentLines,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
} = await import("../prompts/system-prompt.js");

/**
 * Extract just the workspace-file content (IDENTITY.md, SOUL.md, USER.md,
 * BOOTSTRAP.md) from the full system prompt, stripping all static
 * instruction sections, configuration, and skills catalog.
 *
 * After the cache-boundary refactor, workspace content lives in the
 * dynamic block (after SYSTEM_PROMPT_CACHE_BOUNDARY).
 */
function basePrompt(result: string): string {
  // The workspace files are in the dynamic block after the cache boundary.
  const boundaryIdx = result.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
  let s =
    boundaryIdx >= 0
      ? result.slice(boundaryIdx + SYSTEM_PROMPT_CACHE_BOUNDARY.length)
      : result;
  for (const heading of [
    "## Configuration",
    "## Skills Catalog",
    "## Available Skills",
    "## External Communications Identity",
    "## Connected Services",
    "## Dynamic Skill Authoring Workflow",
  ]) {
    if (s.startsWith(heading)) {
      s = "";
      break;
    }
    const idx = s.indexOf(`\n\n${heading}`);
    if (idx !== -1) s = s.slice(0, idx);
  }
  return s;
}

describe("buildSystemPrompt", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test("returns empty string when no files exist", () => {
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe("");
  });

  test("uses SOUL.md when it exists", () => {
    writeFileSync(join(TEST_DIR, "SOUL.md"), "# My Soul\n\nBe awesome.");
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe("# My Soul\n\nBe awesome.");
  });

  test("uses IDENTITY.md when it exists", () => {
    writeFileSync(
      join(TEST_DIR, "IDENTITY.md"),
      "# My Identity\n\nI am Vellum.",
    );
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe("# My Identity\n\nI am Vellum.");
  });

  test("composes IDENTITY.md + SOUL.md when both exist", () => {
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "# Identity\n\nI am Vellum.");
    writeFileSync(join(TEST_DIR, "SOUL.md"), "# Soul\n\nBe thoughtful.");
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe(
      "# Identity\n\nI am Vellum.\n\n# Soul\n\nBe thoughtful.",
    );
  });

  test("ignores empty SOUL.md", () => {
    writeFileSync(join(TEST_DIR, "SOUL.md"), "   \n  \n  ");
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe("");
  });

  test("ignores empty IDENTITY.md", () => {
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "");
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe("");
  });

  test("trims whitespace from file content", () => {
    writeFileSync(join(TEST_DIR, "SOUL.md"), "\n  Be kind  \n\n");
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe("Be kind");
  });

  test("appends skills catalog when skills are configured", () => {
    const skillsDir = join(TEST_DIR, "skills");
    mkdirSync(join(skillsDir, "release-checklist"), { recursive: true });
    writeFileSync(
      join(skillsDir, "release-checklist", "SKILL.md"),
      '---\nname: "Release Checklist"\ndescription: "Deployment checks."\n---\n\nRun checks.\n',
    );
    writeFileSync(join(skillsDir, "SKILLS.md"), "- release-checklist\n");

    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "Custom identity");
    const result = buildSystemPrompt();
    expect(result).toContain("Custom identity");
    expect(result).toContain("## Available Skills");
    expect(result).toContain("**release-checklist**: Deployment checks");
  });

  test("keeps SOUL.md and IDENTITY.md additive with skills", () => {
    const skillsDir = join(TEST_DIR, "skills");
    mkdirSync(join(skillsDir, "incident-response"), { recursive: true });
    writeFileSync(
      join(skillsDir, "incident-response", "SKILL.md"),
      '---\nname: "Incident Response"\ndescription: "Triage and mitigation."\n---\n\nFollow runbook.\n',
    );
    writeFileSync(join(skillsDir, "SKILLS.md"), "- incident-response\n");
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "Identity content");
    writeFileSync(join(TEST_DIR, "SOUL.md"), "Soul content");

    const result = buildSystemPrompt();
    expect(result).toContain("Identity content\n\nSoul content");
    expect(result).toContain("## Available Skills");
    expect(result.indexOf("Soul content")).toBeLessThan(
      result.indexOf("## Available Skills"),
    );
  });

  test("includes external service access section", () => {
    const result = buildSystemPrompt();
    expect(result).toContain("## External Service Access");
    expect(result).toContain("browser automation as last resort");
  });

  test("does not include removed sections", () => {
    const result = buildSystemPrompt();
    expect(result).not.toContain("## External Communications Identity");
  });

  test("does not include removed domain routing sections", () => {
    const result = buildSystemPrompt();
    expect(result).not.toContain("## Routing: Phone Calls");
    expect(result).not.toContain("## Routing: Guardian Verification");
    expect(result).not.toContain("## Routing: Voice Setup");
    expect(result).not.toContain("## Routing: Starter Tasks");
  });

  test("does not include removed memory persistence section", () => {
    const result = buildSystemPrompt();
    expect(result).not.toContain("## Memory Persistence");
  });

  test("omits user skills from catalog when none are configured", () => {
    const result = buildSystemPrompt();
    // No user skill directories exist, so no user skills should appear.
    // Bundled skills (e.g. app-builder) may still be present.
    expect(result).not.toContain("release-checklist");
    expect(result).not.toContain("incident-response");
  });

  test("appends USER.md after base prompt", () => {
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "Base prompt");
    writeFileSync(join(TEST_DIR, "USER.md"), "# User\n\nName: Alice");
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe("Base prompt\n\n# User\n\nName: Alice");
  });

  test("appends USER.md after IDENTITY + SOUL", () => {
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "Identity");
    writeFileSync(join(TEST_DIR, "SOUL.md"), "Soul");
    writeFileSync(join(TEST_DIR, "USER.md"), "User info");
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe("Identity\n\nSoul\n\nUser info");
  });

  test("USER.md alone becomes the prompt", () => {
    writeFileSync(join(TEST_DIR, "USER.md"), "Just user");
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe("Just user");
  });

  test("ignores empty USER.md", () => {
    writeFileSync(join(TEST_DIR, "USER.md"), "  \n  ");
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe("");
  });

  describe("app-builder tool ownership guidance", () => {
    test("iteration guidance does not mention app_update for HTML changes", () => {
      const result = buildSystemPrompt();
      // The iteration line should not reference app_update for changing HTML
      expect(result).not.toContain("use `app_update` to change the HTML");
    });

    test("onboarding playbook does not reference Home Base for accent color", () => {
      // Starter task playbooks only included during onboarding (BOOTSTRAP.md exists)
      writeFileSync(join(TEST_DIR, "BOOTSTRAP.md"), "# First run");
      const result = buildSystemPrompt();
      // The make_it_yours playbook should not reference Home Base anymore
      expect(result).not.toContain("Home Base dashboard");
      expect(result).not.toContain(
        "using `app_update` to regenerate the Home Base HTML",
      );
    });
  });

  test("includes UPDATES.md content when file exists", () => {
    writeFileSync(join(TEST_DIR, "UPDATES.md"), "# v1.2\n\nNew feature added.");
    const result = buildSystemPrompt();
    expect(result).toContain("## Recent Updates");
    expect(result).toContain("New feature added.");
  });

  test("omits updates section when UPDATES.md is empty", () => {
    writeFileSync(join(TEST_DIR, "UPDATES.md"), "   \n  \n  ");
    const result = buildSystemPrompt();
    expect(result).not.toContain("## Recent Updates");
  });

  test("omits updates section when UPDATES.md does not exist", () => {
    const result = buildSystemPrompt();
    expect(result).not.toContain("## Recent Updates");
  });

  test("includes update handling instructions when UPDATES.md exists", () => {
    writeFileSync(join(TEST_DIR, "UPDATES.md"), "# v1.3\n\nSome update notes.");
    const result = buildSystemPrompt();
    expect(result).toContain("### Update Handling");
    expect(result).toContain("Use your judgment");
  });

  test("omits update handling instructions when UPDATES.md is absent", () => {
    const result = buildSystemPrompt();
    expect(result).not.toContain("### Update Handling");
  });

  test("strips comment lines starting with _ from prompt files", () => {
    writeFileSync(
      join(TEST_DIR, "IDENTITY.md"),
      "# Identity\n_ This is a comment\nI am Vellum.\n_ Another comment",
    );
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe("# Identity\nI am Vellum.");
  });

  test("collapses whitespace around stripped comment lines", () => {
    writeFileSync(
      join(TEST_DIR, "SOUL.md"),
      "First paragraph\n\n_ Comment between paragraphs\n\nSecond paragraph",
    );
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe("First paragraph\n\nSecond paragraph");
  });

  test("file with only comment lines is treated as empty", () => {
    writeFileSync(join(TEST_DIR, "SOUL.md"), "_ All comments\n_ Nothing else");
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe("");
  });
});

describe("stripCommentLines", () => {
  test("removes lines starting with _", () => {
    expect(stripCommentLines("hello\n_ comment\nworld")).toBe("hello\nworld");
  });

  test("removes lines with leading whitespace before _", () => {
    expect(stripCommentLines("hello\n  _ indented comment\nworld")).toBe(
      "hello\nworld",
    );
  });

  test("preserves underscores mid-line", () => {
    expect(stripCommentLines("hello_world\nsome_var = 1")).toBe(
      "hello_world\nsome_var = 1",
    );
  });

  test("collapses triple+ newlines to double", () => {
    expect(stripCommentLines("a\n\n_ removed\n\nb")).toBe("a\n\nb");
  });

  test("returns empty string for all-comment content", () => {
    expect(stripCommentLines("_ one\n_ two")).toBe("");
  });

  test("preserves _-prefixed lines inside fenced code blocks", () => {
    const input = [
      "## Example",
      "",
      "```python",
      "class Singleton:",
      "    _instance = None",
      "    _private_var = 42",
      "```",
      "",
      "_ This comment should be removed",
      "After the block.",
    ].join("\n");
    const expected = [
      "## Example",
      "",
      "```python",
      "class Singleton:",
      "    _instance = None",
      "    _private_var = 42",
      "```",
      "",
      "After the block.",
    ].join("\n");
    expect(stripCommentLines(input)).toBe(expected);
  });

  test("handles multiple code blocks with _-prefixed lines", () => {
    const input = [
      "_ comment before",
      "```",
      "_keep_this",
      "```",
      "_ comment between",
      "```js",
      "_anotherVar = true",
      "```",
      "_ comment after",
    ].join("\n");
    const expected = [
      "```",
      "_keep_this",
      "```",
      "```js",
      "_anotherVar = true",
      "```",
    ].join("\n");
    expect(stripCommentLines(input)).toBe(expected);
  });

  test("does not treat deeply indented backticks as fence delimiters", () => {
    const input = [
      "Some text",
      "    ```",
      "_ this should be stripped",
      "End",
    ].join("\n");
    expect(stripCommentLines(input)).toBe("Some text\n    ```\nEnd");
  });

  test("recognizes tilde fences as code block delimiters", () => {
    const input = ["~~~", "_keep_this", "~~~", "_ strip this"].join("\n");
    expect(stripCommentLines(input)).toBe("~~~\n_keep_this\n~~~");
  });

  test("allows up to 3 spaces before a fence delimiter", () => {
    const input = [
      "Start",
      "   ```python",
      "_keep = True",
      "   ```",
      "_ strip this",
    ].join("\n");
    expect(stripCommentLines(input)).toBe(
      "Start\n   ```python\n_keep = True\n   ```",
    );
  });

  test("normalizes CRLF line endings before processing", () => {
    const input = "First\r\n\r\n_ comment\r\n\r\nSecond";
    expect(stripCommentLines(input)).toBe("First\n\nSecond");
  });

  test("collapses blank lines correctly with CRLF input", () => {
    const input = "a\r\n\r\n_ removed\r\n\r\nb";
    expect(stripCommentLines(input)).toBe("a\n\nb");
  });
});

describe("ensurePromptFiles", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test("creates all 3 files from templates when none exist", () => {
    ensurePromptFiles();

    for (const file of ["SOUL.md", "IDENTITY.md", "USER.md"]) {
      const dest = join(TEST_DIR, file);
      expect(existsSync(dest)).toBe(true);
      const content = readFileSync(dest, "utf-8");
      expect(content.length).toBeGreaterThan(0);
    }
  });

  test("does not overwrite existing files", () => {
    const customContent = "My custom identity";
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), customContent);

    ensurePromptFiles();

    const content = readFileSync(join(TEST_DIR, "IDENTITY.md"), "utf-8");
    expect(content).toBe(customContent);

    // Other files should be created
    expect(existsSync(join(TEST_DIR, "SOUL.md"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "USER.md"))).toBe(true);
  });

  test("handles missing template gracefully (warn, no crash)", () => {
    // ensurePromptFiles resolves templates from the actual templates/ dir.
    // Since templates exist in the repo this test verifies the function
    // doesn't crash. A true "missing template" scenario would require
    // mocking the filesystem, but the important contract is: no throw.
    expect(() => ensurePromptFiles()).not.toThrow();
  });

  test("creates BOOTSTRAP.md on first run when no prompt files exist", () => {
    ensurePromptFiles();

    const bootstrapPath = join(TEST_DIR, "BOOTSTRAP.md");
    expect(existsSync(bootstrapPath)).toBe(true);
    const content = readFileSync(bootstrapPath, "utf-8");
    expect(content.length).toBeGreaterThan(0);
  });

  test("does not recreate BOOTSTRAP.md when other prompt files already exist", () => {
    // Simulate a workspace where onboarding completed: core files exist,
    // BOOTSTRAP.md was deleted by the user.
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "My identity");
    writeFileSync(join(TEST_DIR, "SOUL.md"), "My soul");
    writeFileSync(join(TEST_DIR, "USER.md"), "My user");

    ensurePromptFiles();

    const bootstrapPath = join(TEST_DIR, "BOOTSTRAP.md");
    expect(existsSync(bootstrapPath)).toBe(false);
  });

  test("does not recreate BOOTSTRAP.md when at least one prompt file exists", () => {
    // Even if only one core file exists, it's not a fresh install.
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "My identity");

    ensurePromptFiles();

    const bootstrapPath = join(TEST_DIR, "BOOTSTRAP.md");
    expect(existsSync(bootstrapPath)).toBe(false);
  });
});
