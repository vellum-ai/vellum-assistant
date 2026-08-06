import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { getWorkspacePluginsDir } from "../../util/platform.js";
import {
  declarationExistsOnDisk,
  parsePluginScheduleDeclarations,
} from "../plugin-schedule-declarations.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Create a plugin dir whose schedules/ contains the given relative files. */
function makePlugin(files: Record<string, string>): string {
  const pluginDir = mkdtempSync(join(tmpdir(), "plugin-sched-test-"));
  tempDirs.push(pluginDir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(pluginDir, "schedules", rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return pluginDir;
}

/** A directory declaration exercising every config field. */
const FULL_DIGEST: Record<string, string> = {
  "digest/config.json": JSON.stringify({
    expression: "0 9 * * *",
    description: "Daily digest",
    timezone: "America/New_York",
    max_retries: 2,
    retry_backoff_ms: 5000,
    quiet: true,
    inference_profile: "fast",
    timeout_ms: 30000,
  }),
  "digest/index.md": "Summarize the day.\n",
};

/** A minimal directory declaration: `config.json` plus an `index.md` prompt. */
function execDeclaration(
  name: string,
  config: Record<string, unknown>,
  body = "Prompt.",
): Record<string, string> {
  return {
    [`${name}/config.json`]: JSON.stringify(config),
    [`${name}/index.md`]: body,
  };
}

describe("parsePluginScheduleDeclarations", () => {
  test("returns empty results when schedules/ is absent", () => {
    const pluginDir = mkdtempSync(join(tmpdir(), "plugin-sched-test-"));
    tempDirs.push(pluginDir);
    expect(parsePluginScheduleDeclarations(pluginDir, "p")).toEqual({
      declarations: [],
      errors: [],
    });
  });

  test("parses a declaration with full config", () => {
    const pluginDir = makePlugin(FULL_DIGEST);
    const { declarations, errors } = parsePluginScheduleDeclarations(
      pluginDir,
      "news",
    );
    expect(errors).toEqual([]);
    expect(declarations).toHaveLength(1);
    const decl = declarations[0]!;
    expect(decl.sourceKey).toBe("plugin:news/digest");
    expect(decl.name).toBe("digest");
    expect(decl.mode).toBe("execute");
    expect(decl.message).toBe("Summarize the day.");
    expect(decl.scriptInvocation).toBeNull();
    expect(decl.config).toEqual({
      expression: "0 9 * * *",
      syntax: "cron",
      timezone: "America/New_York",
      description: "Daily digest",
      maxRetries: 2,
      retryBackoffMs: 5000,
      quiet: true,
      inferenceProfile: "fast",
      timeoutMs: 30000,
      enabled: true,
    });
    expect(decl.definitionHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("applies defaults: optional fields null, enabled true, syntax auto-detected", () => {
    const pluginDir = makePlugin(
      execDeclaration("simple", { expression: "*/5 * * * *" }, "Ping."),
    );
    const { declarations, errors } = parsePluginScheduleDeclarations(
      pluginDir,
      "p",
    );
    expect(errors).toEqual([]);
    expect(declarations[0]!.config).toEqual({
      expression: "*/5 * * * *",
      syntax: "cron",
      timezone: null,
      description: null,
      maxRetries: null,
      retryBackoffMs: null,
      quiet: null,
      inferenceProfile: null,
      timeoutMs: null,
      enabled: true,
    });
  });

  test("honors declared enabled: false", () => {
    const pluginDir = makePlugin(
      execDeclaration(
        "paused",
        { expression: "0 9 * * *", enabled: false },
        "Hi.",
      ),
    );
    const { declarations } = parsePluginScheduleDeclarations(pluginDir, "p");
    expect(declarations[0]!.config.enabled).toBe(false);
  });

  test("parses an RRULE declaration with explicit syntax", () => {
    const pluginDir = makePlugin(
      execDeclaration(
        "weekly",
        {
          expression:
            "DTSTART;TZID=America/New_York:20260101T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO",
          expression_syntax: "rrule",
        },
        "Weekly.",
      ),
    );
    const { declarations, errors } = parsePluginScheduleDeclarations(
      pluginDir,
      "p",
    );
    expect(errors).toEqual([]);
    expect(declarations[0]!.config.syntax).toBe("rrule");
  });

  test("parses a declaration with index.md", () => {
    const pluginDir = makePlugin({
      "report/config.json": JSON.stringify({ expression: "0 8 * * 1" }),
      "report/index.md": "Write the weekly report.\n",
    });
    const { declarations, errors } = parsePluginScheduleDeclarations(
      pluginDir,
      "p",
    );
    expect(errors).toEqual([]);
    const decl = declarations[0]!;
    expect(decl.sourceKey).toBe("plugin:p/report");
    expect(decl.mode).toBe("execute");
    expect(decl.message).toBe("Write the weekly report.");
    expect(decl.scriptInvocation).toBeNull();
  });

  test("parses a declaration with index.sh, honoring a direct shebang", () => {
    const pluginDir = makePlugin({
      "backup/config.json": JSON.stringify({ expression: "0 3 * * *" }),
      "backup/index.sh": "#!/bin/bash\necho backup\n",
    });
    const { declarations, errors } = parsePluginScheduleDeclarations(
      pluginDir,
      "p",
    );
    expect(errors).toEqual([]);
    const decl = declarations[0]!;
    expect(decl.mode).toBe("script");
    expect(decl.message).toBeNull();
    // Explicit interpreter: platform installs do not restore exec bits, so a
    // bare path invocation would fail with exit 126.
    expect(decl.scriptInvocation).toBe(
      `'/bin/bash' '${join(pluginDir, "schedules", "backup", "index.sh")}'`,
    );
    expect(decl.scriptInvocation).not.toContain("echo backup");
  });

  test("honors an env-form shebang: interpreter plus one argument", () => {
    const pluginDir = makePlugin({
      "backup/config.json": JSON.stringify({ expression: "0 3 * * *" }),
      "backup/index.sh": "#!/usr/bin/env bash\necho backup\n",
    });
    const { declarations, errors } = parsePluginScheduleDeclarations(
      pluginDir,
      "p",
    );
    expect(errors).toEqual([]);
    expect(declarations[0]!.scriptInvocation).toBe(
      `'/usr/bin/env' 'bash' '${join(pluginDir, "schedules", "backup", "index.sh")}'`,
    );
  });

  test("a shebang-less index.sh is parsed by sh, still via an explicit interpreter", () => {
    const pluginDir = makePlugin({
      "backup/config.json": JSON.stringify({ expression: "0 3 * * *" }),
      "backup/index.sh": "echo backup\n",
    });
    const { declarations, errors } = parsePluginScheduleDeclarations(
      pluginDir,
      "p",
    );
    expect(errors).toEqual([]);
    // The exec-bit rationale holds for every form: the invocation never
    // executes the script path directly.
    expect(declarations[0]!.scriptInvocation).toBe(
      `sh '${join(pluginDir, "schedules", "backup", "index.sh")}'`,
    );
  });

  describe("fail-closed cases", () => {
    test("a markdown file directly under schedules/ errors, siblings still load", () => {
      const pluginDir = makePlugin({
        "digest.md": '---\nexpression: "0 9 * * *"\n---\nPrompt.',
        ...execDeclaration("ok", { expression: "0 9 * * *" }),
      });
      const { declarations, errors } = parsePluginScheduleDeclarations(
        pluginDir,
        "p",
      );
      expect(declarations.map((d) => d.name)).toEqual(["ok"]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        pluginName: "p",
        scheduleName: "digest.md",
        sourceKey: "plugin:p/digest.md",
      });
      expect(errors[0]!.reason).toContain("must be directories");
    });

    test("directory with no entrypoint errors", () => {
      const pluginDir = makePlugin({
        "empty/config.json": JSON.stringify({ expression: "0 9 * * *" }),
      });
      const { declarations, errors } = parsePluginScheduleDeclarations(
        pluginDir,
        "p",
      );
      expect(declarations).toEqual([]);
      expect(errors[0]!.reason).toContain("no entrypoint");
    });

    test("directory with both index.md and index.sh errors", () => {
      const pluginDir = makePlugin({
        "twin/config.json": JSON.stringify({ expression: "0 9 * * *" }),
        "twin/index.md": "Prompt.",
        "twin/index.sh": "echo hi",
      });
      const { declarations, errors } = parsePluginScheduleDeclarations(
        pluginDir,
        "p",
      );
      expect(declarations).toEqual([]);
      expect(errors[0]!.reason).toContain("multiple entrypoints");
    });

    test("unsupported entrypoint (index.ts) errors", () => {
      const pluginDir = makePlugin({
        "ts/config.json": JSON.stringify({ expression: "0 9 * * *" }),
        "ts/index.ts": "export {};",
      });
      const { errors } = parsePluginScheduleDeclarations(pluginDir, "p");
      expect(errors[0]!.reason).toContain('unsupported entrypoint "index.ts"');
    });

    test("stray non-md file in schedules/ errors", () => {
      const pluginDir = makePlugin({ "notes.txt": "hi" });
      const { errors } = parsePluginScheduleDeclarations(pluginDir, "p");
      expect(errors[0]!.reason).toContain("must be directories");
    });

    test("directory missing config.json errors", () => {
      const pluginDir = makePlugin({ "bare/index.md": "Prompt." });
      const { errors } = parsePluginScheduleDeclarations(pluginDir, "p");
      expect(errors[0]!.reason).toContain("missing config.json");
    });

    test("invalid JSON in config.json errors", () => {
      const pluginDir = makePlugin({
        "bad/config.json": "{ nope",
        "bad/index.md": "Prompt.",
      });
      const { errors } = parsePluginScheduleDeclarations(pluginDir, "p");
      expect(errors[0]!.reason).toContain("not valid JSON");
    });

    test("directory index.md with frontmatter errors", () => {
      const pluginDir = makePlugin({
        "fm/config.json": JSON.stringify({ expression: "0 9 * * *" }),
        "fm/index.md": '---\nexpression: "0 9 * * *"\n---\nPrompt.',
      });
      const { errors } = parsePluginScheduleDeclarations(pluginDir, "p");
      expect(errors[0]!.reason).toContain("must not contain frontmatter");
    });

    test("missing expression errors", () => {
      const pluginDir = makePlugin(
        execDeclaration("noexpr", { description: "nope" }),
      );
      const { errors } = parsePluginScheduleDeclarations(pluginDir, "p");
      expect(errors[0]!.reason).toContain("expression");
    });

    test("invalid cron expression errors", () => {
      const pluginDir = makePlugin(
        execDeclaration("badcron", { expression: "99 99 * * *" }),
      );
      const { errors } = parsePluginScheduleDeclarations(pluginDir, "p");
      expect(errors[0]!.reason).toContain("invalid cron expression");
      expect(errors[0]!.kind).toBe("invalid");
    });

    test("RRULE without DTSTART errors", () => {
      const pluginDir = makePlugin(
        execDeclaration("badrrule", {
          expression: "RRULE:FREQ=DAILY",
          expression_syntax: "rrule",
        }),
      );
      const { errors } = parsePluginScheduleDeclarations(pluginDir, "p");
      expect(errors[0]!.reason).toContain("DTSTART");
    });

    test("unknown config key errors", () => {
      const pluginDir = makePlugin(
        execDeclaration("typo", {
          expression: "0 9 * * *",
          expresion_syntax: "cron",
        }),
      );
      const { errors } = parsePluginScheduleDeclarations(pluginDir, "p");
      expect(errors[0]!.reason).toContain("invalid config");
    });

    test("timeout_ms below the script minimum errors", () => {
      const pluginDir = makePlugin(
        execDeclaration("fast", { expression: "0 9 * * *", timeout_ms: 500 }),
      );
      const { declarations, errors } = parsePluginScheduleDeclarations(
        pluginDir,
        "p",
      );
      expect(declarations).toEqual([]);
      expect(errors[0]!.reason).toContain("timeout_ms must be between");
    });

    test("timeout_ms above the script maximum errors", () => {
      const pluginDir = makePlugin(
        execDeclaration("slow", {
          expression: "0 9 * * *",
          timeout_ms: 1800001,
        }),
      );
      const { errors } = parsePluginScheduleDeclarations(pluginDir, "p");
      expect(errors[0]!.reason).toContain("timeout_ms must be between");
    });

    test("single-fire RRULE (COUNT=1) errors; larger counts stay valid", () => {
      const single = makePlugin(
        execDeclaration("once", {
          expression: "DTSTART:21260101T090000Z\nRRULE:FREQ=DAILY;COUNT=1",
          expression_syntax: "rrule",
        }),
      );
      const parsed = parsePluginScheduleDeclarations(single, "p");
      expect(parsed.declarations).toEqual([]);
      expect(parsed.errors[0]!.reason).toContain("must be recurring");

      const thrice = makePlugin(
        execDeclaration("thrice", {
          expression: "DTSTART:21260101T090000Z\nRRULE:FREQ=DAILY;COUNT=3",
          expression_syntax: "rrule",
        }),
      );
      expect(parsePluginScheduleDeclarations(thrice, "p").errors).toEqual([]);
    });

    test("an RRULE whose UNTIL is already past errors", () => {
      const pluginDir = makePlugin(
        execDeclaration("expired", {
          expression:
            "DTSTART:20200101T090000Z\nRRULE:FREQ=DAILY;UNTIL=20200201T000000Z",
          expression_syntax: "rrule",
        }),
      );
      const { declarations, errors } = parsePluginScheduleDeclarations(
        pluginDir,
        "p",
      );
      expect(declarations).toEqual([]);
      expect(errors[0]!.reason).toContain("no upcoming occurrences");
      // A well-formed recurrence with nothing left to fire, not a mistake:
      // the reconciler stays quiet about it once the row has stopped.
      expect(errors[0]!.kind).toBe("ended");
    });

    test("a COUNT-bounded RRULE with every occurrence consumed reports 'ended'", () => {
      const pluginDir = makePlugin(
        execDeclaration("consumed", {
          expression: "DTSTART:20200101T090000Z\nRRULE:FREQ=DAILY;COUNT=5",
          expression_syntax: "rrule",
        }),
      );
      const { declarations, errors } = parsePluginScheduleDeclarations(
        pluginDir,
        "p",
      );
      expect(declarations).toEqual([]);
      expect(errors[0]!.kind).toBe("ended");
    });

    test("empty prompt body errors", () => {
      const pluginDir = makePlugin(
        execDeclaration("hollow", { expression: "0 9 * * *" }, "   \n"),
      );
      const { errors } = parsePluginScheduleDeclarations(pluginDir, "p");
      expect(errors[0]!.reason).toContain("prompt body is empty");
    });

    test("one bad declaration never blocks siblings", () => {
      const pluginDir = makePlugin({
        ...execDeclaration("bad", { expression: "nonsense" }),
        ...execDeclaration("good", { expression: "0 9 * * *" }),
        "also-good/config.json": JSON.stringify({ expression: "0 10 * * *" }),
        "also-good/index.md": "Prompt.",
      });
      const { declarations, errors } = parsePluginScheduleDeclarations(
        pluginDir,
        "p",
      );
      expect(declarations.map((d) => d.name)).toEqual(["also-good", "good"]);
      expect(errors.map((e) => e.scheduleName)).toEqual(["bad"]);
    });
  });

  describe("definitionHash", () => {
    test("is stable across parses of identical content", () => {
      const files = {
        ...FULL_DIGEST,
        "backup/config.json": JSON.stringify({ expression: "0 3 * * *" }),
        "backup/index.sh": "echo backup\n",
      };
      const a = parsePluginScheduleDeclarations(makePlugin(files), "p");
      const b = parsePluginScheduleDeclarations(makePlugin(files), "p");
      for (const decl of a.declarations) {
        const twin = b.declarations.find((d) => d.name === decl.name);
        expect(twin?.definitionHash).toBe(decl.definitionHash);
      }
    });

    test("changes when the prompt body is edited", () => {
      const pluginDir = makePlugin(FULL_DIGEST);
      const before = parsePluginScheduleDeclarations(pluginDir, "p")
        .declarations[0]!.definitionHash;
      writeFileSync(
        join(pluginDir, "schedules", "digest", "index.md"),
        "Summarize the week.\n",
      );
      const after = parsePluginScheduleDeclarations(pluginDir, "p")
        .declarations[0]!.definitionHash;
      expect(after).not.toBe(before);
    });

    test("changes when a helper file inside a directory declaration is edited or renamed", () => {
      const pluginDir = makePlugin({
        "backup/config.json": JSON.stringify({ expression: "0 3 * * *" }),
        "backup/index.sh": "sh lib/helper.sh\n",
        "backup/lib/helper.sh": "echo v1\n",
      });
      const parse = () =>
        parsePluginScheduleDeclarations(pluginDir, "p").declarations[0]!
          .definitionHash;
      const original = parse();

      const helperPath = join(
        pluginDir,
        "schedules",
        "backup",
        "lib",
        "helper.sh",
      );
      writeFileSync(helperPath, "echo v2\n");
      const afterEdit = parse();
      expect(afterEdit).not.toBe(original);

      renameSync(
        helperPath,
        join(pluginDir, "schedules", "backup", "lib", "helper2.sh"),
      );
      expect(parse()).not.toBe(afterEdit);
    });

    test("differs between two schedules with different names but same content", () => {
      const config = { expression: "0 9 * * *" };
      const pluginDir = makePlugin({
        ...execDeclaration("a", config, "Same."),
        ...execDeclaration("b", config, "Same."),
      });
      const { declarations } = parsePluginScheduleDeclarations(pluginDir, "p");
      expect(declarations[0]!.definitionHash).not.toBe(
        declarations[1]!.definitionHash,
      );
    });
  });
});

/**
 * The fire-time probe, which answers whether a row may still run its
 * declaration. It resolves against the workspace plugins directory, so these
 * cases install their fixtures there rather than in a scratch directory.
 */
describe("declarationExistsOnDisk", () => {
  const pluginsDir = getWorkspacePluginsDir();
  const outsideRoot = mkdtempSync(join(tmpdir(), "plugin-sched-outside-"));

  afterAll(() => {
    rmSync(outsideRoot, { recursive: true, force: true });
    rmSync(pluginsDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    rmSync(pluginsDir, { recursive: true, force: true });
    mkdirSync(pluginsDir, { recursive: true });
  });

  /** An installed plugin carrying a manifest and one `digest` declaration. */
  function makeInstalledPlugin(parent: string, name: string): string {
    const dir = join(parent, name);
    const declarationDir = join(dir, "schedules", "digest");
    mkdirSync(declarationDir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name, version: "1.0.0" }),
    );
    writeFileSync(
      join(declarationDir, "config.json"),
      JSON.stringify({ expression: "0 9 * * *" }),
    );
    writeFileSync(join(declarationDir, "index.sh"), "#!/bin/sh\necho hi\n");
    return dir;
  }

  test("a declaration installed under the plugins directory is available", async () => {
    makeInstalledPlugin(pluginsDir, "news");

    expect(await declarationExistsOnDisk("plugin:news/digest")).toBe(true);
  });

  test("a plugin root symlinked outside the plugins directory is not available", async () => {
    const escapee = makeInstalledPlugin(outsideRoot, "escapee");
    symlinkSync(escapee, join(pluginsDir, "news"));

    // The loader refuses to activate such a root, and the row's stored
    // invocation names an absolute path inside it, so answering true here
    // would run out-of-tree code at fire time.
    expect(await declarationExistsOnDisk("plugin:news/digest")).toBe(false);
  });

  test("a declaration directory symlinked outside its plugin is not available", async () => {
    const dir = makeInstalledPlugin(pluginsDir, "news");
    const elsewhere = join(outsideRoot, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(
      join(elsewhere, "config.json"),
      JSON.stringify({ expression: "0 9 * * *" }),
    );
    writeFileSync(join(elsewhere, "index.sh"), "#!/bin/sh\necho hi\n");
    rmSync(join(dir, "schedules", "digest"), { recursive: true, force: true });
    symlinkSync(elsewhere, join(dir, "schedules", "digest"));

    expect(await declarationExistsOnDisk("plugin:news/digest")).toBe(false);
  });

  test("a plugin root symlinked inside the plugins directory stays available", async () => {
    makeInstalledPlugin(pluginsDir, "real");
    symlinkSync(join(pluginsDir, "real"), join(pluginsDir, "alias"));

    // Enumeration keeps a contained link, so the probe agrees with it.
    expect(await declarationExistsOnDisk("plugin:alias/digest")).toBe(true);
  });

  test("a disabled plugin's declaration is not available", async () => {
    const dir = makeInstalledPlugin(pluginsDir, "news");
    writeFileSync(join(dir, ".disabled"), "");

    expect(await declarationExistsOnDisk("plugin:news/digest")).toBe(false);
  });
});
