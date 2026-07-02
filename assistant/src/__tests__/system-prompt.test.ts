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

// Stub persona-resolver so tests can dictate the slug `buildSystemPrompt`
// sees without needing to write contact rows to the test DB. The user
// and channel persona files themselves now flow through bundled sections
// (`10-user-persona` / `11-channel-persona`) that read from disk, so
// persona *content* is exercised by writing the file under TEST_DIR
// rather than mocking it here. Tests mutate `mockPersona` in place;
// the default (all-null) matches a fresh workspace with no contacts
// and no `users/default.md`.
const mockPersona: {
  userSlug: string | null;
  guardianPersona: string | null;
} = { userSlug: null, guardianPersona: null };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const realPersonaResolver = require("../prompts/persona-resolver.js");
mock.module("../prompts/persona-resolver.js", () => ({
  ...realPersonaResolver,
  resolveUserSlug: () => mockPersona.userSlug,
  resolveGuardianPersona: () => mockPersona.guardianPersona,
}));

const mockOauthConnections: Array<{
  provider: string;
  status: string;
  accountInfo?: string | null;
}> = [];
const mockManagedConnections: Array<{
  provider: string;
  accountInfo?: string | null;
}> = [];

mock.module("../oauth/oauth-store.js", () => ({
  listConnections: () => mockOauthConnections,
}));

mock.module("../credential-execution/managed-catalog.js", () => ({
  getCachedManagedConnections: () => mockManagedConnections,
}));

// Import after mock
const { buildSystemPrompt, ensurePromptFiles, stripCommentLines } =
  await import("../prompts/system-prompt.js");
const { SYSTEM_PROMPT_CACHE_BOUNDARY } =
  await import("../prompts/cache-boundary.js");

describe("buildSystemPrompt", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    // Reset persona stub so each test starts from a fresh
    // no-guardian baseline.
    mockPersona.userSlug = null;
    mockPersona.guardianPersona = null;
    mockOauthConnections.length = 0;
    mockManagedConnections.length = 0;
  });

  afterEach(() => {
    for (const name of [
      "IDENTITY.md",
      "SOUL.md",
      "USER.md",
      "BOOTSTRAP.md",
      "VOICE.md",
      "skills",
      "users",
      "channels",
    ]) {
      const p = join(TEST_DIR, name);
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
    }
    for (const key of Object.keys(mockLoadedConfig)) {
      delete mockLoadedConfig[key];
    }
  });

  test("uses SOUL.md when it exists", () => {
    writeFileSync(join(TEST_DIR, "SOUL.md"), "# My Soul\n\nBe awesome.");
    const result = buildSystemPrompt();
    // SOUL.md renders as the `09-soul` workspace-backed section.
    expect(result).toContain("# My Soul\n\nBe awesome.");
  });

  test("uses IDENTITY.md when it exists", () => {
    writeFileSync(
      join(TEST_DIR, "IDENTITY.md"),
      "# My Identity\n\nI am Vellum.",
    );
    const result = buildSystemPrompt();
    // IDENTITY.md renders as the `08-identity` workspace-backed section.
    expect(result).toContain("# My Identity\n\nI am Vellum.");
  });

  test("composes IDENTITY.md + SOUL.md when both exist", () => {
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "# Identity\n\nI am Vellum.");
    writeFileSync(join(TEST_DIR, "SOUL.md"), "# Soul\n\nBe thoughtful.");
    const result = buildSystemPrompt();
    // IDENTITY renders before SOUL (sections `08-identity` then
    // `09-soul`).
    expect(result).toContain("# Identity\n\nI am Vellum.");
    expect(result).toContain("# Soul\n\nBe thoughtful.");
    const identityIdx = result.indexOf("# Identity\n\nI am Vellum.");
    const soulIdx = result.indexOf("# Soul\n\nBe thoughtful.");
    expect(identityIdx).toBeLessThan(soulIdx);
  });

  test("renders runtime-computed dynamic sections after workspace-only static sections", () => {
    const systemPromptsDir = join(TEST_DIR, "prompts", "system");
    mkdirSync(systemPromptsDir, { recursive: true });
    writeFileSync(
      join(systemPromptsDir, "99-org-policy.md"),
      "# Org policy\n\nMostly static workspace policy.\n",
    );
    mockManagedConnections.push({
      provider: "google",
      accountInfo: "user@example.com",
    });

    const result = buildSystemPrompt();

    const staticIdx = result.indexOf("Mostly static workspace policy.");
    const dynamicIdx = result.indexOf("# Connected Services");
    expect(staticIdx).toBeGreaterThan(-1);
    expect(dynamicIdx).toBeGreaterThan(-1);
    expect(dynamicIdx).toBeGreaterThan(staticIdx);
  });

  test("side-chain prompt options still include IDENTITY.md and SOUL.md", () => {
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "# Identity\n\nI am Vellum.");
    writeFileSync(join(TEST_DIR, "SOUL.md"), "# Soul\n\nBe thoughtful.");

    const result = buildSystemPrompt({
      excludeBootstrap: true,
      excludeCustomPrefix: true,
    });

    expect(result).toContain("# Identity\n\nI am Vellum.");
    expect(result).toContain("# Soul\n\nBe thoughtful.");
  });

  test("ignores empty SOUL.md", () => {
    writeFileSync(join(TEST_DIR, "SOUL.md"), "   \n  \n  ");
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "# Identity\n\nI am Vellum.");
    const result = buildSystemPrompt();
    // IDENTITY renders but SOUL is gated off by the renderer's
    // empty-body check; no SOUL content should appear.
    expect(result).toContain("# Identity\n\nI am Vellum.");
    expect(result).not.toContain("   \n  \n  ");
  });

  test("ignores empty IDENTITY.md", () => {
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "");
    writeFileSync(join(TEST_DIR, "SOUL.md"), "# Soul\n\nBe thoughtful.");
    const result = buildSystemPrompt();
    // SOUL renders but IDENTITY's empty file is gated off by the
    // renderer's empty-body check.
    expect(result).toContain("# Soul\n\nBe thoughtful.");
  });

  test("gates off the unmodified bundled IDENTITY.md template when no BOOTSTRAP.md is present", () => {
    // Regression: the seeded IDENTITY.md ships with `_`-comment lines, so
    // the raw workspace body never equals the comment-stripped bundled
    // template. `isTemplateContent` must comment-strip BOTH sides — otherwise
    // detection fails and the `08-identity` transform leaks the blank
    // template scaffolding into every fresh post-onboarding prompt.
    const bundledIdentity = readFileSync(
      join(import.meta.dirname, "..", "prompts", "templates", "IDENTITY.md"),
      "utf-8",
    );
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), bundledIdentity);
    writeFileSync(join(TEST_DIR, "SOUL.md"), "# Soul\n\nBe thoughtful.");
    const result = buildSystemPrompt();
    // SOUL still renders; the template scaffolding must not.
    expect(result).toContain("# Soul\n\nBe thoughtful.");
    expect(result).not.toContain("(not yet chosen)");
  });

  test("includes the unmodified bundled IDENTITY.md template during bootstrap", () => {
    // The mirror case: when BOOTSTRAP.md is active the template is included
    // verbatim so the model can see the field structure and produce a valid
    // file_write on the first turn.
    const bundledIdentity = readFileSync(
      join(import.meta.dirname, "..", "prompts", "templates", "IDENTITY.md"),
      "utf-8",
    );
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), bundledIdentity);
    writeFileSync(
      join(TEST_DIR, "BOOTSTRAP.md"),
      "# First run\n\nGet started.",
    );
    const result = buildSystemPrompt();
    // The bundled template's placeholder scaffolding (the `(not yet chosen)`
    // field markers) renders verbatim during bootstrap — the mirror of the
    // gating test above, which asserts it is absent without BOOTSTRAP.md.
    expect(result).toContain("(not yet chosen)");
  });

  test("trims whitespace from file content", () => {
    writeFileSync(join(TEST_DIR, "SOUL.md"), "\n  Be kind  \n\n");
    const result = buildSystemPrompt();
    // SOUL.md renders via the `09-soul` workspace-backed section;
    // stripCommentLines + trim run inside the section renderer.
    expect(result).toContain("Be kind");
    expect(result).not.toContain("\n  Be kind  \n");
  });

  test("does not include skills catalog in system prompt", () => {
    const skillsDir = join(TEST_DIR, "skills");
    mkdirSync(join(skillsDir, "release-checklist"), { recursive: true });
    writeFileSync(
      join(skillsDir, "release-checklist", "SKILL.md"),
      '---\nname: "Release Checklist"\ndescription: "Deployment checks."\n---\n\nRun checks.\n',
    );

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
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "Identity content");
    writeFileSync(join(TEST_DIR, "SOUL.md"), "Soul content");

    const result = buildSystemPrompt();
    // Both files render in the static prefix via `08-identity` /
    // `09-soul`.  Verify both are present and the skills catalog is
    // still suppressed.
    expect(result).toContain("Identity content");
    expect(result).toContain("Soul content");
    expect(result).not.toContain("## Available Skills");
  });

  test("does not include removed sections", () => {
    const result = buildSystemPrompt();
    expect(result).not.toContain("## External Communications Identity");
    expect(result).not.toContain("## In-Chat Configuration");
    expect(result).not.toContain("## Historical Mentions Are Read-Only");
    expect(result).not.toContain("## Communication");
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
    expect(result).toContain("Identity");
    expect(result).toContain("Soul");
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
    expect(result).toContain("Identity");
  });

  test("includes resolved user persona in the static prefix", () => {
    // User persona flows through the `10-user-persona` bundled section,
    // which reads from `users/<userSlug>.md` (or `users/default.md` as
    // a fallback).  Set the slug + write the file to exercise both.
    mockPersona.userSlug = "alice";
    mkdirSync(join(TEST_DIR, "users"), { recursive: true });
    writeFileSync(
      join(TEST_DIR, "users", "alice.md"),
      "# User persona\n\nName: Alice",
    );
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "Identity");
    writeFileSync(join(TEST_DIR, "SOUL.md"), "Soul");
    const result = buildSystemPrompt();
    // IDENTITY, SOUL, and the user persona all render as workspace-backed
    // bundled sections in the assembled prompt.
    expect(result).toContain("Identity");
    expect(result).toContain("Soul");
    expect(result).toContain("# User persona");
    expect(result).toContain("Name: Alice");
  });

  test("user persona falls back to users/default.md when the slug's file is missing", () => {
    // The `10-user-persona` section's workspacePath is
    // `["users/{{userSlug}}.md", "users/default.md"]` — when the
    // primary file doesn't exist the renderer falls through to default.
    mockPersona.userSlug = "alice";
    mkdirSync(join(TEST_DIR, "users"), { recursive: true });
    writeFileSync(
      join(TEST_DIR, "users", "default.md"),
      "# Default persona\n\nNo contact bound.",
    );
    const result = buildSystemPrompt();
    expect(result).toContain("# Default persona");
    expect(result).toContain("No contact bound.");
  });

  test("includes channel persona from channels/<channelSlug>.md", () => {
    // Channel persona flows through the `11-channel-persona` section.
    // Default channel is "vellum" when no channelCapabilities passed.
    mkdirSync(join(TEST_DIR, "channels"), { recursive: true });
    writeFileSync(
      join(TEST_DIR, "channels", "vellum.md"),
      "# Channel persona\n\nThis is the Vellum channel.",
    );
    const result = buildSystemPrompt();
    expect(result).toContain("# Channel persona");
    expect(result).toContain("This is the Vellum channel.");
  });

  test("includes VOICE.md as the 12-voice section with prepended heading", () => {
    // VOICE.md flows through the `12-voice` bundled section.  The
    // section transform prepends `# Voice Profile` so the file itself
    // stays heading-free; the model writes voice markers as plain
    // bullets / lines.
    writeFileSync(
      join(TEST_DIR, "VOICE.md"),
      "- Prefers lowercase. Replies tightly. Skips greetings.",
    );
    const result = buildSystemPrompt();
    expect(result).toContain("# Voice Profile");
    expect(result).toContain("Prefers lowercase");
  });

  test("omits the 12-voice section when VOICE.md is missing", () => {
    const result = buildSystemPrompt();
    expect(result).not.toContain("# Voice Profile");
  });

  test("omits the 12-voice section when VOICE.md is empty / whitespace-only", () => {
    writeFileSync(join(TEST_DIR, "VOICE.md"), "   \n\n  \n");
    const result = buildSystemPrompt();
    expect(result).not.toContain("# Voice Profile");
  });

  describe("BOOTSTRAP.md user persona placeholder", () => {
    test("substitutes {{userSlug}} with the resolved slug when a guardian slug is resolvable", () => {
      // Simulate a guardian contact whose userFile resolves to alice.md.
      mockPersona.userSlug = "alice";
      writeFileSync(
        join(TEST_DIR, "BOOTSTRAP.md"),
        "# First run\n\nSave facts to users/{{userSlug}}.md immediately.",
      );
      const result = buildSystemPrompt();
      expect(result).toContain("users/alice.md");
      expect(result).not.toContain("{{userSlug}}");
    });

    test("falls back to users/default.md when no slug is resolvable", () => {
      writeFileSync(
        join(TEST_DIR, "BOOTSTRAP.md"),
        "# First run\n\nSave facts to users/{{userSlug}}.md immediately.",
      );
      const result = buildSystemPrompt();
      expect(result).toContain("users/default.md");
      expect(result).not.toContain("{{userSlug}}");
    });

    test("leaves no unresolved placeholders in the bundled BOOTSTRAP.md template", () => {
      // Render the real bundled BOOTSTRAP.md the daemon ships and verify
      // substitution leaves no leftover {{userSlug}} placeholder, whether or
      // not the current template happens to reference it.
      mockPersona.userSlug = "alice";
      const bundled = readFileSync(
        join(import.meta.dirname, "..", "prompts", "templates", "BOOTSTRAP.md"),
        "utf-8",
      );
      writeFileSync(join(TEST_DIR, "BOOTSTRAP.md"), bundled);
      const result = buildSystemPrompt();
      expect(result).not.toContain("{{userSlug}}");
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

  test("strips comment lines starting with _ from prompt files", () => {
    writeFileSync(
      join(TEST_DIR, "IDENTITY.md"),
      "# Identity\n_ This is a comment\nI am Vellum.\n_ Another comment",
    );
    const result = buildSystemPrompt();
    // IDENTITY.md renders in the static prefix via the 08-identity section,
    // so we assert against the full prompt rather than basePrompt.
    expect(result).toContain("# Identity\nI am Vellum.");
    expect(result).not.toContain("_ This is a comment");
    expect(result).not.toContain("_ Another comment");
  });

  test("collapses whitespace around stripped comment lines", () => {
    writeFileSync(
      join(TEST_DIR, "SOUL.md"),
      "First paragraph\n\n_ Comment between paragraphs\n\nSecond paragraph",
    );
    const result = buildSystemPrompt();
    // SOUL.md renders in the static prefix via the 09-soul section, so we
    // assert against the full prompt rather than basePrompt.  Comment lines
    // are stripped and surrounding whitespace collapsed by renderSection.
    expect(result).toContain("First paragraph\n\nSecond paragraph");
    expect(result).not.toContain("Comment between paragraphs");
  });

  test("file with only comment lines is treated as empty", () => {
    writeFileSync(join(TEST_DIR, "SOUL.md"), "_ All comments\n_ Nothing else");
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "# Identity\n\nI am Vellum.");
    const result = buildSystemPrompt();
    // Comment-only SOUL.md gets stripped down to "" by
    // `stripCommentLines` and is then gated off by the renderer's
    // empty-body check; only IDENTITY contributes content here.
    expect(result).toContain("# Identity\n\nI am Vellum.");
    expect(result).not.toContain("_ All comments");
    expect(result).not.toContain("_ Nothing else");
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
      expect(result).toContain("You are operating in demo mode.");
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
      // IDENTITY.md renders via 08-identity in the static prefix after
      // the 00-prefix slot.
      const prefixIdx = result.indexOf("Custom prefix");
      const identityIdx = result.indexOf("I am Vellum.");
      expect(prefixIdx).toBeGreaterThan(-1);
      expect(identityIdx).toBeGreaterThan(prefixIdx);
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
      writeFileSync(PARALLEL_FILE, "---\nenabled: false\n---\nIgnored body.\n");
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

    describe("cache breakpoints", () => {
      test("default breakpoint splits the prompt after 11-channel-persona", () => {
        /**
         * Tests that the bundled `cacheBreakpoint` on 11-channel-persona
         * places the boundary marker between the stable sections and the
         * volatile 12-voice section.
         */
        // GIVEN a workspace where a volatile section (12-voice) renders
        writeFileSync(join(TEST_DIR, "VOICE.md"), "- Prefers lowercase.");

        // WHEN the system prompt is built
        const result = buildSystemPrompt();

        // THEN the boundary marker sits before the voice content and
        // after the stable instruction sections
        const boundaryIdx = result.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
        expect(boundaryIdx).toBeGreaterThan(-1);
        expect(result.indexOf("<use_parallel_tool_calls>")).toBeLessThan(
          boundaryIdx,
        );
        expect(result.indexOf("# Voice Profile")).toBeGreaterThan(boundaryIdx);
      });

      test("breakpoint splits even when the declaring section gates off", () => {
        /**
         * Tests that the split is resolved against the section ordering,
         * not the rendered output — an absent channel persona must not
         * merge the blocks around it.
         */
        // GIVEN no channel persona file exists but a volatile section renders
        writeFileSync(join(TEST_DIR, "VOICE.md"), "- Prefers lowercase.");

        // WHEN the system prompt is built
        const result = buildSystemPrompt();

        // THEN the boundary marker is still present
        expect(result).toContain(SYSTEM_PROMPT_CACHE_BOUNDARY);
      });

      test("no boundary marker when nothing renders after the breakpoint", () => {
        /**
         * Tests that empty trailing blocks are dropped so the marker
         * never dangles at the end of the prompt.
         */
        // GIVEN a fresh workspace with no volatile sections (no VOICE.md,
        // no BOOTSTRAP.md, no connections)
        // WHEN the system prompt is built
        const result = buildSystemPrompt();

        // THEN no boundary marker appears
        expect(result).not.toContain(SYSTEM_PROMPT_CACHE_BOUNDARY);
      });

      test("workspace override of 11-channel-persona without cache_breakpoint clears the default", () => {
        /**
         * Tests that a workspace override takes full control of the
         * section, including its breakpoint declaration.
         */
        // GIVEN a workspace override of 11-channel-persona with no
        // cache_breakpoint frontmatter, and a volatile section that renders
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        writeFileSync(
          join(SYSTEM_PROMPTS_DIR, "11-channel-persona.md"),
          "Override channel persona.\n",
        );
        writeFileSync(join(TEST_DIR, "VOICE.md"), "- Prefers lowercase.");

        // WHEN the system prompt is built
        const result = buildSystemPrompt();

        // THEN the override body renders but no boundary marker appears
        expect(result).toContain("Override channel persona.");
        expect(result).not.toContain(SYSTEM_PROMPT_CACHE_BOUNDARY);
      });

      test("frontmatter cache_breakpoint on a workspace section places the boundary there", () => {
        /**
         * Tests that users can declare the breakpoint position via
         * `cache_breakpoint: true` frontmatter, and that only the first
         * declaration (in id-sort order) is honored.
         */
        // GIVEN a custom workspace section declaring a cache breakpoint
        // ahead of the bundled default on 11-channel-persona
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        writeFileSync(
          join(SYSTEM_PROMPTS_DIR, "00-aaa-custom.md"),
          "---\ncache_breakpoint: true\n---\nCustom head section.\n",
        );
        writeFileSync(join(TEST_DIR, "VOICE.md"), "- Prefers lowercase.");

        // WHEN the system prompt is built
        const result = buildSystemPrompt();

        // THEN exactly one boundary appears, right after the custom section
        const boundaryIdx = result.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
        expect(boundaryIdx).toBeGreaterThan(-1);
        expect(result.indexOf("Custom head section.")).toBeLessThan(
          boundaryIdx,
        );
        expect(result.indexOf("<use_parallel_tool_calls>")).toBeGreaterThan(
          boundaryIdx,
        );

        // AND the bundled default declaration on 11-channel-persona is
        // ignored — no second marker
        expect(
          result.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY, boundaryIdx + 1),
        ).toBe(-1);
      });
    });

    describe("containerized section (slot 02)", () => {
      const CONTAINERIZED_FILE = join(
        SYSTEM_PROMPTS_DIR,
        "02-containerized.md",
      );

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
        expect(result).toContain("## Assistant CLI");
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
        // in the rest of the system prompt (e.g. "A" inside "API keys").
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

      test("section keys missing from ctx gate the body off (treated as falsy)", () => {
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        writeFileSync(
          SECTION_FILE,
          FRONTMATTER + "{{#noSuchFlag}}hidden{{/noSuchFlag}}\n",
        );
        const result = buildSystemPrompt();
        expect(result).not.toContain("{{#noSuchFlag}}");
        expect(result).not.toContain("hidden");
      });

      test("inverted section keys missing from ctx render the body (undefined is falsy)", () => {
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        writeFileSync(
          SECTION_FILE,
          FRONTMATTER + "{{^noSuchFlag}}shown{{/noSuchFlag}}\n",
        );
        const result = buildSystemPrompt();
        expect(result).toContain("shown");
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
        expect(result).toContain("## Sending Files to the User");
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
        expect(result).toContain("vellum://");
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
        expect(result).toContain("## Credential Security");
      });

      test("bundled credential-security default renders when no workspace override", () => {
        // Bundled `06-credential-security` registry entry is the source of
        // default truth; no workspace override → renderer falls through to
        // bundled body.
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        const result = buildSystemPrompt();
        expect(result).toContain("## Credential Security");
        expect(result).toContain("Never ask users to share secrets");
        expect(result).toContain("`assistant credentials prompt`");
      });

      test("renders after the attachment section to preserve original order", () => {
        // Registry ids sort by numeric prefix, so `06-credential-security`
        // renders after the preceding static section `04-attachment`.
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        const result = buildSystemPrompt();
        const attachmentIdx = result.indexOf("## Sending Files to the User");
        const credentialIdx = result.indexOf("## Credential Security");
        expect(attachmentIdx).toBeGreaterThan(-1);
        expect(credentialIdx).toBeGreaterThan(-1);
        expect(attachmentIdx).toBeLessThan(credentialIdx);
      });
    });

    describe("external-content section (slot 07)", () => {
      const EXTERNAL_FILE = join(SYSTEM_PROMPTS_DIR, "07-external-content.md");

      test("workspace external-content file is rendered into the static block", () => {
        mkdirSync(SYSTEM_PROMPTS_DIR, { recursive: true });
        writeFileSync(
          EXTERNAL_FILE,
          "## External Content\n\nWorkspace override marker NEBULA_9X.\n",
        );
        const result = buildSystemPrompt();
        expect(result).toContain("## External Content");
        expect(result).toContain("Workspace override marker NEBULA_9X.");
        expect(result).toContain("## External Content");
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
