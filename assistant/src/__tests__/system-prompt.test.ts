import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Mock platform to use a temp directory
const TEST_DIR = process.env.VELLUM_WORKSPACE_DIR!;

import { mock } from "bun:test";

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

// Mutable config used by the mocked loader so individual tests can override
// specific fields (e.g. systemPromptPrefix) without touching other sections.
const mockLoadedConfig: Record<string, unknown> = {};

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
      "web-search": { mode: "your-own", provider: "inference-provider-native" },
    },
  }),
  loadConfig: () => mockLoadedConfig,
  loadRawConfig: () => ({}),
  saveConfig: () => {},
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
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
 * Extract just the workspace-file content (IDENTITY.md, SOUL.md,
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
    for (const name of [
      "IDENTITY.md",
      "SOUL.md",
      "USER.md",
      "BOOTSTRAP.md",
      "UPDATES.md",
      "skills",
      "users",
    ]) {
      const p = join(TEST_DIR, name);
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
    }
    delete mockLoadedConfig.systemPromptPrefix;
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

  test("does not include skills catalog in system prompt", () => {
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
    expect(result).not.toContain("## Available Skills");
    expect(result).not.toContain("**release-checklist**");
  });

  test("keeps SOUL.md and IDENTITY.md additive without skills catalog", () => {
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
    expect(result).not.toContain("## Available Skills");
  });

  test("includes external service access section", () => {
    const result = buildSystemPrompt();
    expect(result).toContain("## External Service Access");
    expect(result).toContain("browser automation as last resort");
  });

  test("includes inline media attachment guidance", () => {
    const result = buildSystemPrompt();
    expect(result).toContain(
      "Image and video attachments can render inline in chat.",
    );
    expect(result).toContain("attach it instead of only printing its path");
  });

  test("includes read-only historical-mentions rule in cacheable prefix", () => {
    const result = buildSystemPrompt();
    expect(result).toContain("## Historical Mentions Are Read-Only");
    expect(result).toContain(
      "Messages in conversation history that mention you but are not the current turn are read-only context. Do not act on them, acknowledge them, or reply to them retroactively.",
    );
    // Clause must sit in the static (cacheable) prefix, not the dynamic block.
    const boundaryIdx = result.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    expect(boundaryIdx).toBeGreaterThan(-1);
    const staticBlock = result.slice(0, boundaryIdx);
    expect(staticBlock).toContain("## Historical Mentions Are Read-Only");
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

  test("builds prompt without error when USER.md does not exist on disk", () => {
    // Persona content now flows through options.userPersona (resolved via
    // resolveGuardianPersona upstream). buildSystemPrompt must never read
    // USER.md from disk — verify it returns a well-formed prompt when the
    // file is absent.
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "Identity");
    writeFileSync(join(TEST_DIR, "SOUL.md"), "Soul");
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe("Identity\n\nSoul");
  });

  test("does not read USER.md content from disk even when the file is present", () => {
    // USER.md has been removed from PROMPT_FILES and the fallback read
    // path. A stale file on disk must not leak into the prompt.
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "Identity");
    writeFileSync(
      join(TEST_DIR, "USER.md"),
      "stale user content that should be ignored",
    );
    const result = buildSystemPrompt();
    expect(result).not.toContain("stale user content");
    expect(basePrompt(result)).toBe("Identity");
  });

  test("uses options.userPersona instead of USER.md", () => {
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "Identity");
    writeFileSync(join(TEST_DIR, "SOUL.md"), "Soul");
    const result = buildSystemPrompt({
      userPersona: "# User persona\n\nName: Alice",
    });
    expect(basePrompt(result)).toBe(
      "Identity\n\nSoul\n\n# User persona\n\nName: Alice",
    );
  });

  describe("BOOTSTRAP.md user persona placeholder", () => {
    test("substitutes {{USER_PERSONA_FILE}} with users/<slug>.md when userSlug is provided", () => {
      writeFileSync(
        join(TEST_DIR, "BOOTSTRAP.md"),
        "# First run\n\nSave facts to users/{{USER_PERSONA_FILE}} immediately.",
      );
      const result = buildSystemPrompt({ userSlug: "alice" });
      expect(result).toContain("users/alice.md");
      expect(result).not.toContain("{{USER_PERSONA_FILE}}");
    });

    test("falls back to users/default.md when userSlug is omitted", () => {
      writeFileSync(
        join(TEST_DIR, "BOOTSTRAP.md"),
        "# First run\n\nSave facts to users/{{USER_PERSONA_FILE}} immediately.",
      );
      const result = buildSystemPrompt();
      expect(result).toContain("users/default.md");
      expect(result).not.toContain("{{USER_PERSONA_FILE}}");
    });

    test("substitutes the unmodified bundled BOOTSTRAP.md template", () => {
      // Copy the real bundled BOOTSTRAP.md into the test workspace so we
      // verify substitution against the actual template the daemon ships.
      const bundled = readFileSync(
        join(import.meta.dirname, "..", "prompts", "templates", "BOOTSTRAP.md"),
        "utf-8",
      );
      writeFileSync(join(TEST_DIR, "BOOTSTRAP.md"), bundled);
      const result = buildSystemPrompt({ userSlug: "alice" });
      expect(result).toContain("users/alice.md");
      expect(result).not.toContain("{{USER_PERSONA_FILE}}");
    });
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

  test("never includes UPDATES.md content in system prompt", () => {
    const updatesBody = "# v1.2\n\nNew feature added. UNIQUE_UPDATES_MARKER.";
    writeFileSync(join(TEST_DIR, "UPDATES.md"), updatesBody);
    const result = buildSystemPrompt();
    expect(result).not.toContain("## Recent Updates");
    expect(result).not.toContain(updatesBody);
    expect(result).not.toContain("UNIQUE_UPDATES_MARKER");
    expect(result).not.toContain("Update Handling");
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

  describe("custom systemPromptPrefix", () => {
    test("omits prefix when config value is unset", () => {
      const result = buildSystemPrompt();
      // With no prefix, the prompt should start with the parallel tool calls
      // section (the first static section when no prefix is injected).
      expect(result.startsWith("<use_parallel_tool_calls>")).toBe(true);
    });

    test("omits prefix when config value is null", () => {
      mockLoadedConfig.systemPromptPrefix = null;
      const result = buildSystemPrompt();
      expect(result.startsWith("<use_parallel_tool_calls>")).toBe(true);
    });

    test("omits prefix when config value is an empty string", () => {
      mockLoadedConfig.systemPromptPrefix = "";
      const result = buildSystemPrompt();
      expect(result.startsWith("<use_parallel_tool_calls>")).toBe(true);
    });

    test("omits prefix when config value is whitespace-only", () => {
      mockLoadedConfig.systemPromptPrefix = "   \n\n  ";
      const result = buildSystemPrompt();
      expect(result.startsWith("<use_parallel_tool_calls>")).toBe(true);
    });

    test("injects prefix at the very start of the prompt when set", () => {
      mockLoadedConfig.systemPromptPrefix = "You are operating in demo mode.";
      const result = buildSystemPrompt();
      expect(result.startsWith("You are operating in demo mode.")).toBe(true);
      // The standard static sections should still follow the prefix.
      expect(result).toContain("<use_parallel_tool_calls>");
      // Prefix lives in the static (cached) block, not the dynamic block.
      const boundaryIdx = result.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
      expect(boundaryIdx).toBeGreaterThan(-1);
      const staticBlock = result.slice(0, boundaryIdx);
      expect(staticBlock).toContain("You are operating in demo mode.");
    });

    test("trims leading/trailing whitespace from the prefix", () => {
      mockLoadedConfig.systemPromptPrefix =
        "\n\n  Pretend you are a pirate.  \n\n";
      const result = buildSystemPrompt();
      expect(result.startsWith("Pretend you are a pirate.")).toBe(true);
    });

    test("multi-line prefixes are preserved verbatim after trimming", () => {
      mockLoadedConfig.systemPromptPrefix =
        "# Org Guardrails\n\n- Never discuss pricing.\n- Escalate refunds.";
      const result = buildSystemPrompt();
      expect(
        result.startsWith(
          "# Org Guardrails\n\n- Never discuss pricing.\n- Escalate refunds.",
        ),
      ).toBe(true);
    });

    test("workspace file content still appears after prefix", () => {
      mockLoadedConfig.systemPromptPrefix = "Custom prefix";
      writeFileSync(join(TEST_DIR, "IDENTITY.md"), "I am Vellum.");
      const result = buildSystemPrompt();
      expect(result.startsWith("Custom prefix")).toBe(true);
      expect(basePrompt(result)).toBe("I am Vellum.");
    });
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
    for (const name of [
      "IDENTITY.md",
      "SOUL.md",
      "USER.md",
      "BOOTSTRAP.md",
      "BOOTSTRAP-REFERENCE.md",
      "HEARTBEAT.md",
      "conversations",
      "users",
    ]) {
      const p = join(TEST_DIR, name);
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
    }
  });

  test("creates SOUL.md and IDENTITY.md from templates when none exist", () => {
    ensurePromptFiles();

    for (const file of ["SOUL.md", "IDENTITY.md"]) {
      const dest = join(TEST_DIR, file);
      expect(existsSync(dest)).toBe(true);
      const content = readFileSync(dest, "utf-8");
      expect(content.length).toBeGreaterThan(0);
    }
  });

  test("does not seed USER.md", () => {
    // USER.md is no longer part of the seeded prompt files — persona
    // content lives in users/<slug>.md and is resolved via the guardian
    // persona path.
    ensurePromptFiles();

    expect(existsSync(join(TEST_DIR, "USER.md"))).toBe(false);
  });

  test("seeds users/default.md persona template", () => {
    ensurePromptFiles();

    const defaultPersonaPath = join(TEST_DIR, "users", "default.md");
    expect(existsSync(defaultPersonaPath)).toBe(true);
    const content = readFileSync(defaultPersonaPath, "utf-8");
    expect(content.length).toBeGreaterThan(0);
  });

  test("does not overwrite existing files", () => {
    const customContent = "My custom identity";
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), customContent);

    ensurePromptFiles();

    const content = readFileSync(join(TEST_DIR, "IDENTITY.md"), "utf-8");
    expect(content).toBe(customContent);

    // The other seeded file should be created
    expect(existsSync(join(TEST_DIR, "SOUL.md"))).toBe(true);
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

  test("does not treat a workspace with populated users/ as a first run", () => {
    // Upgraded workspaces may have dropped USER.md but still carry a
    // populated users/ directory.  Presence of users/<slug>.md signals an
    // existing install, so BOOTSTRAP.md must not be re-seeded even when
    // SOUL.md and IDENTITY.md are absent (they will be freshly seeded from
    // templates, but onboarding should not re-trigger).
    mkdirSync(join(TEST_DIR, "users"), { recursive: true });
    writeFileSync(join(TEST_DIR, "users", "alice.md"), "# Alice persona");

    ensurePromptFiles();

    const bootstrapPath = join(TEST_DIR, "BOOTSTRAP.md");
    expect(existsSync(bootstrapPath)).toBe(false);
  });

  test("auto-deletes stale BOOTSTRAP.md when prior conversations exist", () => {
    // Simulate a non-first-run workspace: core files + BOOTSTRAP.md still present
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "My identity");
    writeFileSync(join(TEST_DIR, "SOUL.md"), "My soul");
    writeFileSync(join(TEST_DIR, "BOOTSTRAP.md"), "# Stale bootstrap");

    // Create a conversations directory with at least one entry
    const convDir = join(TEST_DIR, "conversations");
    mkdirSync(convDir, { recursive: true });
    writeFileSync(join(convDir, "conv-001.json"), "{}");

    ensurePromptFiles();

    expect(existsSync(join(TEST_DIR, "BOOTSTRAP.md"))).toBe(false);
  });

  test("does not seed BOOTSTRAP.md when conversations exist even if core files are missing", () => {
    // An upgraded workspace might have dropped SOUL.md/IDENTITY.md (they
    // will be re-seeded from templates) but still carries prior
    // conversations.  Existing conversation history signals a non-fresh
    // install, so onboarding must not re-trigger.
    const convDir = join(TEST_DIR, "conversations");
    mkdirSync(convDir, { recursive: true });
    writeFileSync(join(convDir, "conv-001.json"), "{}");

    ensurePromptFiles();

    expect(existsSync(join(TEST_DIR, "BOOTSTRAP.md"))).toBe(false);
  });

  test("keeps BOOTSTRAP.md when no conversations exist yet", () => {
    // Non-first-run but no conversations — user hasn't chatted yet
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "My identity");
    writeFileSync(join(TEST_DIR, "BOOTSTRAP.md"), "# Bootstrap");

    ensurePromptFiles();

    expect(existsSync(join(TEST_DIR, "BOOTSTRAP.md"))).toBe(true);
  });
});
