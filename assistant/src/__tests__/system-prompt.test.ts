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

const noopLogger = new Proxy({} as Record<string, unknown>, {
  get: (_target, prop) => (prop === "child" ? () => noopLogger : () => {}),
});

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

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    sandbox: { enabled: true },
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
} = await import("../prompts/system-prompt.js");

// Import section builders directly from their modules for focused tests
const { buildExternalCommsIdentitySection, buildPhoneCallsRoutingSection } =
  await import("../prompts/sections/routing.js");

/** Strip the Configuration, Skills, and hardcoded preamble sections so base-prompt tests stay focused. */
function basePrompt(result: string): string {
  let s = result;
  // Strip the hardcoded em-dash instruction preamble
  const emDashLine =
    "IMPORTANT: Never use em dashes (\u2014) in your messages. Use commas, periods, or just start a new sentence instead.";
  if (s.startsWith(emDashLine)) {
    s = s.slice(emDashLine.length).replace(/^\n\n/, "");
  }
  for (const heading of [
    "## Configuration",
    "## Skills Catalog",
    "## Available Skills",
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

// =====================================================================
// Prompt budget guardrails
//
// These tests prevent prompt bloat from returning silently. The budget
// is based on the post-audit baseline (PRs 1-7) and should only be
// increased after deliberate review. If a budget test fails, it means
// a change added significant prompt text -- consider whether the new
// content belongs in a skill or runtime injection instead.
// =====================================================================

describe("prompt budget guardrails", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  // The pre-audit system prompt was ~53,000 chars in system-prompt.ts alone.
  // After the audit (PRs 1-7), the assembled prompt without user content or
  // skills catalog is ~20,800 chars — a 61% reduction. This budget gives
  // ~10% headroom above the current size to catch regressions without
  // breaking on minor wording tweaks.
  const TOTAL_BUDGET_CHARS = 23_000;

  test(`total prompt length stays under ${TOTAL_BUDGET_CHARS} chars (no user content, no skills)`, () => {
    const result = buildSystemPrompt();
    expect(result.length).toBeLessThan(TOTAL_BUDGET_CHARS);
  });

  test("prompt is materially smaller than the pre-audit baseline of ~53,000 chars", () => {
    const result = buildSystemPrompt();
    // The prompt should be less than 45% of the original size (~23,850 chars),
    // still enforcing a >55% reduction from the pre-audit baseline.
    const PRE_AUDIT_BASELINE = 53_000;
    expect(result.length).toBeLessThan(PRE_AUDIT_BASELINE * 0.45);
  });

  // Per-section budgets prevent any single section from quietly ballooning.
  // These are generous limits -- the actual sections are much smaller.
  const SECTION_BUDGETS: Record<string, number> = {
    "## Configuration": 1_500,
    "## Assistant CLI": 1_000,
    "## Tool Call Timing": 500,
    "## Tool Permissions": 1_500,
    "## Channel Awareness & Trust Gating": 1_500,
    "## External Communications Identity": 1_000,
    "## Memory & Workspace Persistence": 1_000,
    "## Parallel Task Orchestration": 500,
    "## External Service Access Preference": 1_000,
    "## Routing: Starter Tasks": 500,
    "## Routing: Phone Calls": 500,
    "## Routing: Voice Setup & Troubleshooting": 500,
    "## Skill Authoring": 1_000,
    "## Sending Files to the User": 1_500,
    "## In-Chat Configuration": 2_100,
    "## System Permissions": 500,
    "## Tool Routing: Tasks vs Schedules vs Notifications": 800,
    "## Channel Command Intents": 1_200,
  };

  test("each prompt section stays within its character budget", () => {
    const result = buildSystemPrompt();
    const violations: string[] = [];

    for (const [heading, budget] of Object.entries(SECTION_BUDGETS)) {
      const idx = result.indexOf(heading);
      if (idx === -1) continue;

      // Find the end of this section (start of next ## heading or end of string)
      const afterHeading = idx + heading.length;
      const nextSection = result.indexOf("\n\n## ", afterHeading);
      const sectionEnd = nextSection === -1 ? result.length : nextSection;
      const sectionLength = sectionEnd - idx;

      if (sectionLength > budget) {
        violations.push(
          `"${heading}" is ${sectionLength} chars (budget: ${budget})`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  test("all expected core sections are present in the assembled prompt", () => {
    const result = buildSystemPrompt();
    const expectedSections = [
      "## Configuration",
      "## Assistant CLI",
      "## Tool Call Timing",
      "## Tool Permissions",
      "## Channel Awareness & Trust Gating",
      "## External Communications Identity",
      "## Memory & Workspace Persistence",
      "## Parallel Task Orchestration",
      "## External Service Access Preference",
      "## Routing: Starter Tasks",
      "## Routing: Phone Calls",
      "## Routing: Voice Setup & Troubleshooting",
      "## Skill Authoring",
      "## Sending Files to the User",
      "## In-Chat Configuration",
      "## System Permissions",
      "## Tool Routing: Tasks vs Schedules vs Notifications",
      "## Channel Command Intents",
    ];

    const missing = expectedSections.filter((s) => !result.includes(s));
    expect(missing).toEqual([]);
  });

  test("no deleted or migrated sections have reappeared", () => {
    const result = buildSystemPrompt();
    // These sections were deliberately removed or migrated to skills during the audit
    const deletedSections = [
      "## Starter Task Playbooks",
      "## Dynamic Skill Authoring Workflow",
      "### Quick routing rules",
      "### Entity type routing: work items vs task templates",
      "### Trigger phrases",
      "### Exclusivity rules",
      "### What it does",
    ];

    const reappeared = deletedSections.filter((s) => result.includes(s));
    expect(reappeared).toEqual([]);
  });
});

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
    expect(result).toContain("<available_skills>");
    expect(result).toContain('id="release-checklist"');
    expect(result).toContain("skill_load");
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

  // ── Behavior-level section presence checks ──
  // These verify that expected sections exist in the prompt without
  // pinning exact prose, so the wording can be refined freely.

  test("includes parallel orchestration guidance with swarm_delegate reference", () => {
    const result = buildSystemPrompt();
    expect(result).toContain("## Parallel Task Orchestration");
    expect(result).toContain("swarm_delegate");
  });

  test("includes external service access preference with priority order", () => {
    const result = buildSystemPrompt();
    expect(result).toContain("## External Service Access Preference");
    // Verify the preference hierarchy exists (sandbox -> CLI -> API -> fetch -> browser)
    expect(result).toContain("host_bash");
    expect(result).toContain("Browser automation");
  });

  test("includes external comms identity section with user reference", () => {
    const result = buildSystemPrompt();
    expect(result).toContain("## External Communications Identity");
    expect(result).toContain("**assistant**");
    expect(result).toContain("**John**");
  });

  test("includes phone calls routing dispatch hint", () => {
    const result = buildSystemPrompt();
    expect(result).toContain("## Routing: Phone Calls");
    expect(result).toContain("phone-calls");
  });

  test("includes compact persistence section with memory tools", () => {
    const result = buildSystemPrompt();
    expect(result).toContain("## Memory & Workspace Persistence");
    expect(result).toContain("memory_save");
    expect(result).toContain("memory_recall");
  });

  test("config section references workspace directory from platform util", () => {
    const result = buildSystemPrompt();
    expect(result).toContain(`\`${TEST_DIR}/\``);
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

  describe("migrated content is not in base prompt", () => {
    test("iteration guidance does not mention app_update for HTML changes", () => {
      const result = buildSystemPrompt();
      expect(result).not.toContain("use `app_update` to change the HTML");
    });

    test("starter task playbooks are not embedded in the system prompt", () => {
      // Playbooks are now in the onboarding-starter-tasks skill, loaded on demand
      writeFileSync(join(TEST_DIR, "BOOTSTRAP.md"), "# First run");
      const result = buildSystemPrompt();
      expect(result).not.toContain("## Starter Task Playbooks");
      expect(result).not.toContain("### Playbook: make_it_yours");
      expect(result).toContain("## Routing: Starter Tasks");
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
  });

  test("omits update handling instructions when UPDATES.md is absent", () => {
    const result = buildSystemPrompt();
    expect(result).not.toContain("### Update Handling");
  });

  test("config section lists UPDATES.md", () => {
    const result = buildSystemPrompt();
    expect(result).toContain("`UPDATES.md`");
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

// ── Section builder unit tests ──
// Test individual section builders directly from their modules.

describe("buildExternalCommsIdentitySection", () => {
  test("contains section heading and key contract elements", () => {
    const section = buildExternalCommsIdentitySection();
    expect(section).toContain("## External Communications Identity");
    expect(section).toContain("assistant");
    expect(section).toContain("John");
  });

  test("includes AI disclosure guidance", () => {
    const section = buildExternalCommsIdentitySection();
    expect(section).toContain("Do not volunteer that you are an AI");
  });
});

describe("buildPhoneCallsRoutingSection", () => {
  test("returns compact dispatch hint referencing the skill", () => {
    const section = buildPhoneCallsRoutingSection();
    expect(section).toContain("## Routing: Phone Calls");
    expect(section).toContain("phone-calls");
    expect(section).toContain("Do NOT improvise Twilio setup");
  });

  test("does not include detailed trigger or exclusivity sections", () => {
    const section = buildPhoneCallsRoutingSection();
    // Detailed trigger phrases and exclusivity rules now live in the skill
    expect(section).not.toContain("### Trigger phrases");
    expect(section).not.toContain("### Exclusivity rules");
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
