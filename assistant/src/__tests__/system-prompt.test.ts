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
// specific fields without touching other sections.
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
    "# Connected Services",
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
    for (const key of Object.keys(mockLoadedConfig)) {
      delete mockLoadedConfig[key];
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

  test("does not include removed sections", () => {
    const result = buildSystemPrompt();
    expect(result).not.toContain("## External Communications Identity");
    expect(result).not.toContain("## In-Chat Configuration");
    expect(result).not.toContain("## Historical Mentions Are Read-Only");
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

  describe("BOOTSTRAP.md voice block injection", () => {
    test("prepends warm voice block before BOOTSTRAP.md content when tone is 'warm'", () => {
      writeFileSync(
        join(TEST_DIR, "BOOTSTRAP.md"),
        "# First run\n\nWelcome aboard.",
      );
      const result = buildSystemPrompt({
        onboardingContext: {
          tools: [],
          tasks: [],
          tone: "warm",
        },
      });
      expect(result).toContain("## Voice\nFriendly and easy");
      // Voice block should appear inside the First-Run Ritual section, before the BOOTSTRAP.md body
      const ritualIdx = result.indexOf("# First-Run Ritual");
      const voiceIdx = result.indexOf("## Voice\nFriendly and easy");
      const bootstrapBodyIdx = result.indexOf("# First run\n\nWelcome aboard.");
      expect(ritualIdx).toBeGreaterThan(-1);
      expect(voiceIdx).toBeGreaterThan(ritualIdx);
      expect(voiceIdx).toBeLessThan(bootstrapBodyIdx);
    });

    test("prepends poetic voice block when tone is 'poetic'", () => {
      writeFileSync(
        join(TEST_DIR, "BOOTSTRAP.md"),
        "# First run\n\nWelcome aboard.",
      );
      const result = buildSystemPrompt({
        onboardingContext: {
          tools: [],
          tasks: [],
          tone: "poetic",
        },
      });
      expect(result).toContain("## Voice\nThoughtful and unhurried");
    });

    test("prepends grounded voice block when tone is 'grounded'", () => {
      writeFileSync(
        join(TEST_DIR, "BOOTSTRAP.md"),
        "# First run\n\nWelcome aboard.",
      );
      const result = buildSystemPrompt({
        onboardingContext: {
          tools: [],
          tasks: [],
          tone: "grounded",
        },
      });
      expect(result).toContain("## Voice\nCalm, direct, precise");
    });

    test("does not inject voice block when tone is missing", () => {
      writeFileSync(
        join(TEST_DIR, "BOOTSTRAP.md"),
        "# First run\n\nWelcome aboard.",
      );
      const result = buildSystemPrompt({
        onboardingContext: {
          tools: [],
          tasks: [],
          tone: "",
        },
      });
      expect(result).not.toContain("## Voice");
    });

    test("does not inject voice block when tone is unrecognized", () => {
      writeFileSync(
        join(TEST_DIR, "BOOTSTRAP.md"),
        "# First run\n\nWelcome aboard.",
      );
      const result = buildSystemPrompt({
        onboardingContext: {
          tools: [],
          tasks: [],
          tone: "robotic",
        },
      });
      expect(result).not.toContain("## Voice");
    });

    test("does not inject voice block when onboardingContext is absent", () => {
      writeFileSync(
        join(TEST_DIR, "BOOTSTRAP.md"),
        "# First run\n\nWelcome aboard.",
      );
      const result = buildSystemPrompt();
      expect(result).not.toContain("## Voice");
    });

    test("voice block appears inside First-Run Ritual section before BOOTSTRAP.md body", () => {
      writeFileSync(
        join(TEST_DIR, "BOOTSTRAP.md"),
        "# Onboarding\n\nStep 1: Do stuff.",
      );
      const result = buildSystemPrompt({
        onboardingContext: {
          tools: [],
          tasks: [],
          tone: "energetic",
        },
      });
      const ritualIdx = result.indexOf("# First-Run Ritual");
      const voiceIdx = result.indexOf("## Voice\nFast and generative");
      const bodyIdx = result.indexOf("# Onboarding\n\nStep 1: Do stuff.");
      expect(ritualIdx).toBeGreaterThan(-1);
      expect(voiceIdx).toBeGreaterThan(ritualIdx);
      expect(bodyIdx).toBeGreaterThan(voiceIdx);
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

  describe("workspace system prompt sections", () => {
    const SYSTEM_PROMPTS_DIR = join(TEST_DIR, "prompts", "system");
    const PREFIX_FILE = join(SYSTEM_PROMPTS_DIR, "00-prefix.md");
    const PARALLEL_FILE = join(SYSTEM_PROMPTS_DIR, "01-parallel-tool-calls.md");
    const PREFIX_FRONTMATTER = '---\nenabled: "!excludeCustomPrefix"\n---\n';

    afterEach(() => {
      if (existsSync(SYSTEM_PROMPTS_DIR))
        rmSync(SYSTEM_PROMPTS_DIR, { recursive: true, force: true });
    });

    test("no workspace section files → bundled defaults render directly", () => {
      // Bundled `templates/system/` files are the source of default truth.
      // With no workspace overrides in place, the renderer falls through to
      // the bundled body so `01-parallel-tool-calls.md` ships its default
      // guidance even though `ensurePromptFiles()` no longer seeds section
      // files into the workspace.
      const result = buildSystemPrompt();
      expect(result).toContain("<use_parallel_tool_calls>");
      expect(result).toContain("Batch independent tool calls");
    });

    test("workspace prefix with frontmatter renders body at the very top", () => {
      mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
      writeFileSync(
        PREFIX_FILE,
        PREFIX_FRONTMATTER + "You are operating in demo mode.\n",
      );
      const result = buildSystemPrompt();
      expect(result.startsWith("You are operating in demo mode.")).toBe(true);
      // Prefix lives in the static (cached) block.
      const boundaryIdx = result.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
      expect(boundaryIdx).toBeGreaterThan(-1);
      const staticBlock = result.slice(0, boundaryIdx);
      expect(staticBlock).toContain("You are operating in demo mode.");
    });

    test("workspace file without frontmatter is rendered as-is (always-on)", () => {
      mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
      writeFileSync(PREFIX_FILE, "Plain prefix, no frontmatter.\n");
      const result = buildSystemPrompt();
      expect(result.startsWith("Plain prefix, no frontmatter.")).toBe(true);
    });

    test("renders nothing when workspace prefix body is empty after stripping", () => {
      mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
      writeFileSync(PREFIX_FILE, PREFIX_FRONTMATTER);
      const result = buildSystemPrompt();
      // Frontmatter-only override → workspace wins (existsSync(workspace) is
      // true) but body strips to empty → prefix renders nothing.  No leaked
      // frontmatter at top, but the bundled `01-parallel-tool-calls.md`
      // default still renders because that slot has no workspace override.
      expect(result.startsWith("---")).toBe(false);
      expect(result).toContain("<use_parallel_tool_calls>");
    });

    test("comment-only workspace prefix body strips to nothing — no comment text leaks", () => {
      // Bundled `00-prefix.md` ships frontmatter-only (empty body), so
      // either way the prefix slot contributes nothing — workspace
      // override stripped to empty by `_` comment lines, or bundled
      // fallback already empty.  This test asserts only that the
      // `_`-prefixed comment text does not bleed into the output.
      // Bundled sections at higher slots still render (covered by
      // other tests).
      mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
      writeFileSync(
        PREFIX_FILE,
        PREFIX_FRONTMATTER +
          "_ UNIQUE_COMMENT_MARKER_PURPLE_OCTOPUS\n_ UNIQUE_COMMENT_MARKER_GREEN_HELICOPTER\n",
      );
      const result = buildSystemPrompt();
      expect(result).not.toContain("UNIQUE_COMMENT_MARKER_PURPLE_OCTOPUS");
      expect(result).not.toContain("UNIQUE_COMMENT_MARKER_GREEN_HELICOPTER");
    });

    test("strips comment lines and trims whitespace from rendered body", () => {
      mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
      writeFileSync(
        PREFIX_FILE,
        PREFIX_FRONTMATTER +
          "_ inline note\n\n  Pretend you are a pirate.  \n\n",
      );
      const result = buildSystemPrompt();
      expect(result.startsWith("Pretend you are a pirate.")).toBe(true);
      expect(result).not.toContain("inline note");
    });

    test("multi-line bodies are preserved verbatim after stripping", () => {
      mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
      writeFileSync(
        PREFIX_FILE,
        PREFIX_FRONTMATTER +
          "# Org Guardrails\n\n- Never discuss pricing.\n- Escalate refunds.\n",
      );
      const result = buildSystemPrompt();
      expect(
        result.startsWith(
          "# Org Guardrails\n\n- Never discuss pricing.\n- Escalate refunds.",
        ),
      ).toBe(true);
    });

    test("workspace file content still appears after prefix", () => {
      mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
      writeFileSync(PREFIX_FILE, PREFIX_FRONTMATTER + "Custom prefix\n");
      writeFileSync(join(TEST_DIR, "IDENTITY.md"), "I am Vellum.");
      const result = buildSystemPrompt();
      expect(result.startsWith("Custom prefix")).toBe(true);
      expect(basePrompt(result)).toBe("I am Vellum.");
    });

    test("parallel tool calls section is sourced from workspace when present", () => {
      mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
      writeFileSync(
        PARALLEL_FILE,
        "<use_parallel_tool_calls>\nCustomized parallel guidance.\n</use_parallel_tool_calls>\n",
      );
      const result = buildSystemPrompt();
      expect(result).toContain("Customized parallel guidance.");
      // Body of the bundled file must not leak in.
      expect(result).not.toContain("Batch independent tool calls");
    });

    test("comment-only parallel file suppresses the section entirely", () => {
      mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
      writeFileSync(PARALLEL_FILE, "_ silenced\n");
      const result = buildSystemPrompt();
      expect(result).not.toContain("<use_parallel_tool_calls>");
    });

    test("frontmatter `enabled: !excludeCustomPrefix` suppresses prefix when flag is true", () => {
      mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
      writeFileSync(
        PREFIX_FILE,
        PREFIX_FRONTMATTER + "Should be excluded by sidechain.\n",
      );
      const result = buildSystemPrompt({ excludeCustomPrefix: true });
      expect(result).not.toContain("Should be excluded by sidechain.");
    });

    test("frontmatter `enabled: !excludeCustomPrefix` renders prefix when flag is false", () => {
      mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
      writeFileSync(PREFIX_FILE, PREFIX_FRONTMATTER + "Default-on prefix.\n");
      const result = buildSystemPrompt({ excludeCustomPrefix: false });
      expect(result.startsWith("Default-on prefix.")).toBe(true);
    });

    test("frontmatter `enabled: <unknown-key>` treats key as falsy → suppresses", () => {
      mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
      writeFileSync(
        PREFIX_FILE,
        "---\nenabled: someUnknownFlag\n---\nShould not render.\n",
      );
      const result = buildSystemPrompt();
      expect(result).not.toContain("Should not render.");
    });

    test("frontmatter `enabled: false` (literal boolean) suppresses the section", () => {
      mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
      writeFileSync(
        PREFIX_FILE,
        "---\nenabled: false\n---\nShould not render.\n",
      );
      const result = buildSystemPrompt();
      expect(result).not.toContain("Should not render.");
    });

    test("workspace `enabled: false` on a slot WITH a bundled file suppresses the bundled default", () => {
      // Override wins regardless of body — the workspace file's `enabled: false`
      // frontmatter wins over the bundled `01-parallel-tool-calls.md` default,
      // so the bundled body must not leak into the rendered output.  This is
      // the explicit "user silenced this section" path.
      mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
      writeFileSync(
        PARALLEL_FILE,
        "---\nenabled: false\n---\nIgnored body.\n",
      );
      const result = buildSystemPrompt();
      expect(result).not.toContain("<use_parallel_tool_calls>");
      expect(result).not.toContain("Batch independent tool calls");
      expect(result).not.toContain("Ignored body.");
    });

    test("workspace-only sections (no bundled counterpart) render — discovery union covers both dirs", () => {
      // The renderer collects section ids as the union of bundled and
      // workspace filenames, so any numbered `.md` a user drops into
      // `<workspace>/prompts/system/` joins the render order automatically
      // even when no bundled file shares its id.
      mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
      writeFileSync(
        join(SYSTEM_PROMPTS_DIR, "99-org-policy.md"),
        "# Org policy\n\nUnique workspace-only marker A1B2C3.\n",
      );
      const result = buildSystemPrompt();
      expect(result).toContain("Unique workspace-only marker A1B2C3.");
      // Sort order is filename-driven; the new section sorts after `01-`,
      // so it must appear after the parallel-tool-calls block when both
      // are present.
      mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
      writeFileSync(
        PARALLEL_FILE,
        "<use_parallel_tool_calls>\nbatched.\n</use_parallel_tool_calls>\n",
      );
      const ordered = buildSystemPrompt();
      const parallelIdx = ordered.indexOf("batched.");
      const orgIdx = ordered.indexOf("Unique workspace-only marker A1B2C3.");
      expect(parallelIdx).toBeGreaterThan(-1);
      expect(orgIdx).toBeGreaterThan(parallelIdx);
    });

    describe("containerized section (slot 02)", () => {
      const CONTAINERIZED_FILE = join(SYSTEM_PROMPTS_DIR, "02-containerized.md");

      // The runtime gate is `isContainerized` on the render context, sourced
      // from `getIsContainerized()` which reads `process.env.IS_CONTAINERIZED`.
      // Tests toggle the env var directly and restore it in `finally`.
      let priorIsContainerized: string | undefined;

      beforeEach(() => {
        priorIsContainerized = process.env.IS_CONTAINERIZED;
      });

      afterEach(() => {
        if (priorIsContainerized === undefined)
          delete process.env.IS_CONTAINERIZED;
        else process.env.IS_CONTAINERIZED = priorIsContainerized;
      });

      test("renders the section when IS_CONTAINERIZED=true with {{workspaceDir}} interpolated", () => {
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        writeFileSync(
          CONTAINERIZED_FILE,
          "---\nenabled: isContainerized\n---\n" +
            "Container mounted at `{{workspaceDir}}`. Persist accordingly.\n",
        );
        process.env.IS_CONTAINERIZED = "true";
        const result = buildSystemPrompt();
        expect(result).toContain(
          `Container mounted at \`${TEST_DIR}\`. Persist accordingly.`,
        );
        // The literal `{{workspaceDir}}` must be substituted, not leaked.
        expect(result).not.toContain("{{workspaceDir}}");
      });

      test("omits the section when IS_CONTAINERIZED is unset", () => {
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        writeFileSync(
          CONTAINERIZED_FILE,
          "---\nenabled: isContainerized\n---\nContainer guidance body.\n",
        );
        delete process.env.IS_CONTAINERIZED;
        const result = buildSystemPrompt();
        expect(result).not.toContain("Container guidance body.");
      });

      test("omits the section when IS_CONTAINERIZED=false (string)", () => {
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        writeFileSync(
          CONTAINERIZED_FILE,
          "---\nenabled: isContainerized\n---\nContainer guidance body.\n",
        );
        process.env.IS_CONTAINERIZED = "false";
        const result = buildSystemPrompt();
        expect(result).not.toContain("Container guidance body.");
      });
    });

    describe("cli-reference section (slot 03)", () => {
      const CLI_REFERENCE_FILE = join(
        SYSTEM_PROMPTS_DIR,
        "03-cli-reference.md",
      );

      test("workspace cli-reference file is rendered into the static block", () => {
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        writeFileSync(
          CLI_REFERENCE_FILE,
          "## Assistant CLI\n\nRun `assistant --help` to discover commands.\n",
        );
        const result = buildSystemPrompt();
        expect(result).toContain("## Assistant CLI");
        expect(result).toContain(
          "Run `assistant --help` to discover commands.",
        );
        // Section lives in the static (cached) block.
        const boundaryIdx = result.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
        expect(boundaryIdx).toBeGreaterThan(-1);
        const staticBlock = result.slice(0, boundaryIdx);
        expect(staticBlock).toContain("## Assistant CLI");
      });

      test("bundled cli-reference default renders when no workspace override", () => {
        // Bundled `03-cli-reference.md` is the source of default truth.  No
        // workspace override → renderer falls through to bundled body, so
        // `## Assistant CLI` lands in the static block automatically.
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        const result = buildSystemPrompt();
        expect(result).toContain("## Assistant CLI");
        expect(result).toContain("`assistant` CLI is available");
      });
    });

    describe("access-preference section (slot 05)", () => {
      const ACCESS_FILE = join(SYSTEM_PROMPTS_DIR, "05-access-preference.md");
      // Mirrors the bundled `templates/system/05-access-preference.md` — both
      // variants live in the markdown body and the renderer picks one via
      // mustache-style `{{#hasNoClient}}` / `{{^hasNoClient}}` conditionals.
      const TEMPLATE_BODY = [
        "## External Service Access",
        "",
        "{{#hasNoClient}}",
        "Priority: (1) sandbox `bash` — install tools yourself; (2) browser automation as last resort (no API, visual interaction, or OAuth consent).",
        "{{/hasNoClient}}",
        "{{^hasNoClient}}",
        "Priority: (1) sandbox `bash` - install tools yourself, only fall back to host when you need local files/auth; (2) `host_bash` with CLIs (gh, aws, etc.) using --json flags; (3) browser automation as last resort (no API, visual interaction, or OAuth consent).",
        "{{/hasNoClient}}",
        "",
      ].join("\n");

      test("with-client (default) renders the three-tier priority list", () => {
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        writeFileSync(ACCESS_FILE, TEMPLATE_BODY);
        const result = buildSystemPrompt();
        expect(result).toContain("## External Service Access");
        expect(result).toContain("`host_bash` with CLIs");
        expect(result).toContain("browser automation as last resort");
        // The no-client body (em-dash separator after sandbox `bash`) must
        // not leak when the with-client variant is active.
        expect(result).not.toContain("install tools yourself; (2) browser");
        // Section lives in the static (cached) block.
        const boundaryIdx = result.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
        expect(boundaryIdx).toBeGreaterThan(-1);
        const staticBlock = result.slice(0, boundaryIdx);
        expect(staticBlock).toContain("## External Service Access");
      });

      test("hasNoClient=true renders the two-tier (no host_bash) priority list", () => {
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        writeFileSync(ACCESS_FILE, TEMPLATE_BODY);
        const result = buildSystemPrompt({ hasNoClient: true });
        expect(result).toContain("## External Service Access");
        expect(result).toContain("browser automation as last resort");
        // The host_bash tier must be absent in the no-client variant.
        expect(result).not.toContain("`host_bash` with CLIs");
        // The no-client body uses an em-dash + semicolon separator after
        // sandbox `bash`; the with-client body uses a comma — guard against
        // the wrong variant leaking through.
        expect(result).toContain("install tools yourself; (2) browser");
        expect(result).not.toContain(
          "only fall back to host when you need local files/auth",
        );
      });

      test("standalone tag lines do not bleed extra blank lines into output", () => {
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        writeFileSync(ACCESS_FILE, TEMPLATE_BODY);
        const result = buildSystemPrompt();
        // The heading and the active variant body should sit on adjacent
        // lines separated by exactly one blank line — no triple-newline
        // artifacts from the section markers.
        expect(result).toMatch(
          /## External Service Access\n\nPriority: \(1\) sandbox `bash` -/,
        );
      });

      test("bundled access-preference default renders when no workspace override", () => {
        // Bundled `05-access-preference.md` carries both with-client and
        // no-client variants inline behind mustache section conditionals,
        // so the default body renders without any workspace file present.
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        const result = buildSystemPrompt();
        expect(result).toContain("## External Service Access");
        expect(result).toContain("`host_bash` with CLIs");
      });

      test("renders after the attachment section to preserve original order", () => {
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        writeFileSync(
          join(SYSTEM_PROMPTS_DIR, "04-attachment.md"),
          "## Sending Files to the User\n\nbody.\n",
        );
        writeFileSync(ACCESS_FILE, TEMPLATE_BODY);
        const result = buildSystemPrompt();
        const attachmentIdx = result.indexOf("## Sending Files to the User");
        const accessIdx = result.indexOf("## External Service Access");
        expect(attachmentIdx).toBeGreaterThan(-1);
        expect(accessIdx).toBeGreaterThan(-1);
        expect(attachmentIdx).toBeLessThan(accessIdx);
      });
    });

    describe("mustache section interpolation", () => {
      // Reuse slot 00 (prefix) — its default-on `enabled` predicate is
      // already covered by other tests; here we only care about body
      // interpolation shape.
      const SECTION_FILE = join(SYSTEM_PROMPTS_DIR, "00-prefix.md");
      const FRONTMATTER = '---\nenabled: "!excludeCustomPrefix"\n---\n';

      test("{{#flag}}body{{/flag}} renders body when ctx[flag] is truthy", () => {
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        writeFileSync(
          SECTION_FILE,
          FRONTMATTER + "before {{#hasNoClient}}YES{{/hasNoClient}} after\n",
        );
        const result = buildSystemPrompt({ hasNoClient: true });
        expect(result).toContain("before YES after");
      });

      test("{{#flag}}body{{/flag}} omits body when ctx[flag] is falsy", () => {
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        writeFileSync(
          SECTION_FILE,
          FRONTMATTER + "before {{#hasNoClient}}YES{{/hasNoClient}} after\n",
        );
        const result = buildSystemPrompt({ hasNoClient: false });
        expect(result).toContain("before  after");
        expect(result).not.toContain("YES");
      });

      test("{{^flag}}body{{/flag}} renders body when ctx[flag] is falsy", () => {
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        writeFileSync(
          SECTION_FILE,
          FRONTMATTER + "before {{^hasNoClient}}NO{{/hasNoClient}} after\n",
        );
        const result = buildSystemPrompt({ hasNoClient: false });
        expect(result).toContain("before NO after");
      });

      test("{{^flag}}body{{/flag}} omits body when ctx[flag] is truthy", () => {
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        writeFileSync(
          SECTION_FILE,
          FRONTMATTER + "before {{^hasNoClient}}NO{{/hasNoClient}} after\n",
        );
        const result = buildSystemPrompt({ hasNoClient: true });
        expect(result).toContain("before  after");
        expect(result).not.toContain("NO");
      });

      test("paired {{#flag}} + {{^flag}} acts as if/else", () => {
        // Use long unique markers — single letters collide with substrings
        // in the rest of the system prompt (e.g. "B" lives inside
        // SYSTEM_PROMPT_CACHE_BOUNDARY, "A" inside "API keys").
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        writeFileSync(
          SECTION_FILE,
          FRONTMATTER +
            "{{#hasNoClient}}NO_CLIENT_BRANCH_MARKER{{/hasNoClient}}{{^hasNoClient}}WITH_CLIENT_BRANCH_MARKER{{/hasNoClient}}\n",
        );
        const onTrue = buildSystemPrompt({ hasNoClient: true });
        expect(onTrue).toContain("NO_CLIENT_BRANCH_MARKER");
        expect(onTrue).not.toContain("WITH_CLIENT_BRANCH_MARKER");
        const onFalse = buildSystemPrompt({ hasNoClient: false });
        expect(onFalse).toContain("WITH_CLIENT_BRANCH_MARKER");
        expect(onFalse).not.toContain("NO_CLIENT_BRANCH_MARKER");
      });

      test("section body may contain a {{variable}} substitution", () => {
        // Gate on `hasNoClient` (passed explicitly, so we don't depend on
        // ambient test-env state for `isContainerized`).  The section body
        // includes a `{{workspaceDir}}` interpolation that should resolve
        // to the test workspace path.
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        writeFileSync(
          SECTION_FILE,
          FRONTMATTER +
            "{{#hasNoClient}}cwd={{workspaceDir}}{{/hasNoClient}}\n",
        );
        const result = buildSystemPrompt({ hasNoClient: true });
        expect(result).toMatch(/cwd=\S+/);
        expect(result).not.toContain("{{workspaceDir}}");
      });

      test("unresolved section key is left as a literal", () => {
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        writeFileSync(
          SECTION_FILE,
          FRONTMATTER + "{{#noSuchFlag}}hidden{{/noSuchFlag}}\n",
        );
        const result = buildSystemPrompt();
        expect(result).toContain("{{#noSuchFlag}}hidden{{/noSuchFlag}}");
      });
    });

    describe("attachment section (slot 04)", () => {
      const ATTACHMENT_FILE = join(SYSTEM_PROMPTS_DIR, "04-attachment.md");

      test("workspace attachment file is rendered into the static block", () => {
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        writeFileSync(
          ATTACHMENT_FILE,
          "## Sending Files to the User\n\nUse the `<vellum-attachment />` tag.\n",
        );
        const result = buildSystemPrompt();
        expect(result).toContain("## Sending Files to the User");
        expect(result).toContain("Use the `<vellum-attachment />` tag.");
        // Section lives in the static (cached) block.
        const boundaryIdx = result.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
        expect(boundaryIdx).toBeGreaterThan(-1);
        const staticBlock = result.slice(0, boundaryIdx);
        expect(staticBlock).toContain("## Sending Files to the User");
      });

      test("renders after the cli-reference section to preserve original order", () => {
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        writeFileSync(
          join(SYSTEM_PROMPTS_DIR, "03-cli-reference.md"),
          "## Assistant CLI\n\nUse `assistant --help`.\n",
        );
        writeFileSync(
          ATTACHMENT_FILE,
          "## Sending Files to the User\n\nbody.\n",
        );
        const result = buildSystemPrompt();
        const cliIdx = result.indexOf("## Assistant CLI");
        const attachmentIdx = result.indexOf("## Sending Files to the User");
        expect(cliIdx).toBeGreaterThan(-1);
        expect(attachmentIdx).toBeGreaterThan(-1);
        expect(cliIdx).toBeLessThan(attachmentIdx);
      });

      test("bundled attachment default renders when no workspace override", () => {
        // Bundled `04-attachment.md` is the source of default truth; no
        // workspace override → renderer falls through to bundled body.
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        const result = buildSystemPrompt();
        expect(result).toContain("## Sending Files to the User");
        expect(result).toContain("<vellum-attachment");
      });
    });

    describe("credential-security section (slot 06)", () => {
      const CREDENTIAL_FILE = join(
        SYSTEM_PROMPTS_DIR,
        "06-credential-security.md",
      );

      test("workspace credential-security file is rendered into the static block", () => {
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        writeFileSync(
          CREDENTIAL_FILE,
          "## Credential Security\n\nWorkspace override marker BRAVO_TANGO_7.\n",
        );
        const result = buildSystemPrompt();
        expect(result).toContain("## Credential Security");
        expect(result).toContain("Workspace override marker BRAVO_TANGO_7.");
        // Section lives in the static (cached) block.
        const boundaryIdx = result.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
        expect(boundaryIdx).toBeGreaterThan(-1);
        const staticBlock = result.slice(0, boundaryIdx);
        expect(staticBlock).toContain("## Credential Security");
      });

      test("bundled credential-security default renders when no workspace override", () => {
        // Bundled `06-credential-security` registry entry is the source of
        // default truth; no workspace override → renderer falls through to
        // bundled body.
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        const result = buildSystemPrompt();
        expect(result).toContain("## Credential Security");
        expect(result).toContain("Never ask users to share secrets");
        expect(result).toContain("`credential_store` tool");
      });

      test("renders after the access-preference section to preserve original order", () => {
        // Static-block order from the pre-registry inline build was
        // access-preference → credential-security.  The numeric prefix on
        // the registry id (`06-` > `05-`) preserves that order.
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        const result = buildSystemPrompt();
        const accessIdx = result.indexOf("## External Service Access");
        const credentialIdx = result.indexOf("## Credential Security");
        expect(accessIdx).toBeGreaterThan(-1);
        expect(credentialIdx).toBeGreaterThan(-1);
        expect(accessIdx).toBeLessThan(credentialIdx);
      });
    });

    describe("external-content section (slot 07)", () => {
      const EXTERNAL_FILE = join(
        SYSTEM_PROMPTS_DIR,
        "07-external-content.md",
      );

      test("workspace external-content file is rendered into the static block", () => {
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        writeFileSync(
          EXTERNAL_FILE,
          "## External Content\n\nWorkspace override marker NEBULA_9X.\n",
        );
        const result = buildSystemPrompt();
        expect(result).toContain("## External Content");
        expect(result).toContain("Workspace override marker NEBULA_9X.");
        // Section lives in the static (cached) block.
        const boundaryIdx = result.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
        expect(boundaryIdx).toBeGreaterThan(-1);
        const staticBlock = result.slice(0, boundaryIdx);
        expect(staticBlock).toContain("## External Content");
      });

      test("bundled external-content default renders when no workspace override", () => {
        // Bundled `07-external-content` registry entry is the source of
        // default truth; no workspace override → renderer falls through to
        // bundled body.
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        const result = buildSystemPrompt();
        expect(result).toContain("## External Content");
        expect(result).toContain("third-party data");
        expect(result).toContain("`<external_content>`");
      });

      test("renders after the credential-security section to preserve original order", () => {
        // Static-block order from the pre-registry inline build was
        // credential-security → external-content.  The numeric prefix on
        // the registry id (`07-` > `06-`) preserves that order.
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        const result = buildSystemPrompt();
        const credentialIdx = result.indexOf("## Credential Security");
        const externalIdx = result.indexOf("## External Content");
        expect(credentialIdx).toBeGreaterThan(-1);
        expect(externalIdx).toBeGreaterThan(-1);
        expect(credentialIdx).toBeLessThan(externalIdx);
      });
    });

    describe("background-conversation section (slot 08)", () => {
      const BACKGROUND_FILE = join(
        SYSTEM_PROMPTS_DIR,
        "08-background-conversation.md",
      );

      test("bundled default renders when isBackgroundConversation is true", () => {
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        const result = buildSystemPrompt({ isBackgroundConversation: true });
        expect(result).toContain("## Background Conversation");
        expect(result).toContain("non-interactive background job");
        expect(result).toContain("`notifications` skill");
      });

      test("bundled default is gated out when isBackgroundConversation is false", () => {
        // Mustache `{{#isBackgroundConversation}}...{{/isBackgroundConversation}}`
        // wraps the entire heading + body so the slot interpolates to empty
        // in foreground conversations and the renderer drops it.
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        const result = buildSystemPrompt({ isBackgroundConversation: false });
        expect(result).not.toContain("## Background Conversation");
      });

      test("bundled default is gated out when isBackgroundConversation is omitted", () => {
        // `ctx.isBackgroundConversation` is normalized to `false` when the
        // caller omits the flag, so the gated section drops out cleanly.
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        const result = buildSystemPrompt();
        expect(result).not.toContain("## Background Conversation");
      });

      test("workspace override is also gated by isBackgroundConversation", () => {
        // Workspace overrides flow through the same mustache interpolation,
        // so authors can rely on the same `{{#isBackgroundConversation}}`
        // gate in their custom body.
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        writeFileSync(
          BACKGROUND_FILE,
          "{{#isBackgroundConversation}}## Background Conversation\n\nWorkspace override marker COMET_3K.\n{{/isBackgroundConversation}}\n",
        );

        const offResult = buildSystemPrompt({ isBackgroundConversation: false });
        expect(offResult).not.toContain("## Background Conversation");
        expect(offResult).not.toContain("Workspace override marker COMET_3K.");

        const onResult = buildSystemPrompt({ isBackgroundConversation: true });
        expect(onResult).toContain("## Background Conversation");
        expect(onResult).toContain("Workspace override marker COMET_3K.");
      });

      test("renders after the external-content section when both render", () => {
        // Numeric prefix `08-` > `07-` so the background-conversation
        // section trails the external-content section in the static block.
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        const result = buildSystemPrompt({ isBackgroundConversation: true });
        const externalIdx = result.indexOf("## External Content");
        const backgroundIdx = result.indexOf("## Background Conversation");
        expect(externalIdx).toBeGreaterThan(-1);
        expect(backgroundIdx).toBeGreaterThan(-1);
        expect(externalIdx).toBeLessThan(backgroundIdx);
      });
    });

    test("unresolved {{variable}} is left as a literal in the body", () => {
      mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
      writeFileSync(
        PREFIX_FILE,
        PREFIX_FRONTMATTER + "Has {{somethingMissing}} in body.\n",
      );
      const result = buildSystemPrompt();
      expect(result).toContain("Has {{somethingMissing}} in body.");
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

  test("does not seed bundled system prompt sections into the workspace", () => {
    // Bundled `templates/system/*.md` files are the source of default truth.
    // The renderer reads them directly; the workspace dir is an optional
    // override layer.  On first run we must not pre-populate the workspace
    // with bundled section copies — leaving the workspace empty keeps the
    // override layer purely opt-in and lets bundled defaults flow through
    // automatically as the daemon ships updates.
    ensurePromptFiles();

    const sectionsDir = join(TEST_DIR, "prompts", "system");
    expect(existsSync(sectionsDir)).toBe(false);
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
