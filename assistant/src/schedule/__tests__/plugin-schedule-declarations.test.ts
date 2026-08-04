import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { parsePluginScheduleDeclarations } from "../plugin-schedule-declarations.js";

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

const FLAT_MD = [
  "---",
  'expression: "0 9 * * *"',
  "description: Daily digest",
  "timezone: America/New_York",
  "max_retries: 2",
  "retry_backoff_ms: 5000",
  "quiet: true",
  "inference_profile: fast",
  "timeout_ms: 30000",
  "---",
  "",
  "Summarize the day.",
  "",
].join("\n");

describe("parsePluginScheduleDeclarations", () => {
  test("returns empty results when schedules/ is absent", () => {
    const pluginDir = mkdtempSync(join(tmpdir(), "plugin-sched-test-"));
    tempDirs.push(pluginDir);
    expect(parsePluginScheduleDeclarations(pluginDir, "p")).toEqual({
      declarations: [],
      errors: [],
    });
  });

  test("parses a flat .md declaration with full config", () => {
    const pluginDir = makePlugin({ "digest.md": FLAT_MD });
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
    const pluginDir = makePlugin({
      "simple.md": '---\nexpression: "*/5 * * * *"\n---\nPing.',
    });
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
    const pluginDir = makePlugin({
      "paused.md": '---\nexpression: "0 9 * * *"\nenabled: false\n---\nHi.',
    });
    const { declarations } = parsePluginScheduleDeclarations(pluginDir, "p");
    expect(declarations[0]!.config.enabled).toBe(false);
  });

  test("parses an RRULE declaration with explicit syntax", () => {
    const expression =
      "DTSTART;TZID=America/New_York:20260101T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO";
    const pluginDir = makePlugin({
      "weekly.md": `---\nexpression: "${expression.replace("\n", "\\n")}"\nexpression_syntax: rrule\n---\nWeekly.`,
    });
    const { declarations, errors } = parsePluginScheduleDeclarations(
      pluginDir,
      "p",
    );
    expect(errors).toEqual([]);
    expect(declarations[0]!.config.syntax).toBe("rrule");
  });

  test("parses a directory declaration with index.md", () => {
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

  test("parses a directory declaration with index.sh as an sh path invocation", () => {
    const pluginDir = makePlugin({
      "backup/config.json": JSON.stringify({ expression: "0 3 * * *" }),
      "backup/index.sh": "#!/bin/sh\necho backup\n",
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
      `sh '${join(pluginDir, "schedules", "backup", "index.sh")}'`,
    );
    expect(decl.scriptInvocation).not.toContain("echo backup");
  });

  describe("fail-closed cases", () => {
    test("basename collision between .md and directory loads neither", () => {
      const pluginDir = makePlugin({
        "dup.md": '---\nexpression: "0 9 * * *"\n---\nFlat.',
        "dup/config.json": JSON.stringify({ expression: "0 9 * * *" }),
        "dup/index.md": "Dir.",
        "ok.md": '---\nexpression: "0 9 * * *"\n---\nFine.',
      });
      const { declarations, errors } = parsePluginScheduleDeclarations(
        pluginDir,
        "p",
      );
      expect(declarations.map((d) => d.name)).toEqual(["ok"]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        pluginName: "p",
        scheduleName: "dup",
        sourceKey: "plugin:p/dup",
      });
      expect(errors[0]!.reason).toContain("both");
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
      expect(errors[0]!.reason).toContain("unsupported entry");
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

    test("flat .md without frontmatter errors", () => {
      const pluginDir = makePlugin({ "plain.md": "Just a prompt." });
      const { errors } = parsePluginScheduleDeclarations(pluginDir, "p");
      expect(errors[0]!.reason).toContain("missing frontmatter");
    });

    test("malformed YAML frontmatter errors", () => {
      const pluginDir = makePlugin({
        "broken.md": "---\nexpression: [unclosed\n---\nPrompt.",
      });
      const { errors } = parsePluginScheduleDeclarations(pluginDir, "p");
      expect(errors[0]!.reason).toContain("invalid YAML frontmatter");
    });

    test("missing expression errors", () => {
      const pluginDir = makePlugin({
        "noexpr.md": "---\ndescription: nope\n---\nPrompt.",
      });
      const { errors } = parsePluginScheduleDeclarations(pluginDir, "p");
      expect(errors[0]!.reason).toContain("expression");
    });

    test("invalid cron expression errors", () => {
      const pluginDir = makePlugin({
        "badcron.md": '---\nexpression: "99 99 * * *"\n---\nPrompt.',
      });
      const { errors } = parsePluginScheduleDeclarations(pluginDir, "p");
      expect(errors[0]!.reason).toContain("invalid cron expression");
    });

    test("RRULE without DTSTART errors", () => {
      const pluginDir = makePlugin({
        "badrrule.md":
          "---\nexpression: RRULE:FREQ=DAILY\nexpression_syntax: rrule\n---\nPrompt.",
      });
      const { errors } = parsePluginScheduleDeclarations(pluginDir, "p");
      expect(errors[0]!.reason).toContain("DTSTART");
    });

    test("unknown config key errors", () => {
      const pluginDir = makePlugin({
        "typo.md":
          '---\nexpression: "0 9 * * *"\nexpresion_syntax: cron\n---\nHi.',
      });
      const { errors } = parsePluginScheduleDeclarations(pluginDir, "p");
      expect(errors[0]!.reason).toContain("invalid config");
    });

    test("timeout_ms below the script minimum errors", () => {
      const pluginDir = makePlugin({
        "fast.md": '---\nexpression: "0 9 * * *"\ntimeout_ms: 500\n---\nHi.',
      });
      const { declarations, errors } = parsePluginScheduleDeclarations(
        pluginDir,
        "p",
      );
      expect(declarations).toEqual([]);
      expect(errors[0]!.reason).toContain("timeout_ms must be between");
    });

    test("timeout_ms above the script maximum errors", () => {
      const pluginDir = makePlugin({
        "slow.md":
          '---\nexpression: "0 9 * * *"\ntimeout_ms: 1800001\n---\nHi.',
      });
      const { errors } = parsePluginScheduleDeclarations(pluginDir, "p");
      expect(errors[0]!.reason).toContain("timeout_ms must be between");
    });

    test("single-fire RRULE (COUNT=1) errors; larger counts stay valid", () => {
      const single = makePlugin({
        "once.md":
          '---\nexpression: "DTSTART:20260101T090000Z\\nRRULE:FREQ=DAILY;COUNT=1"\nexpression_syntax: rrule\n---\nHi.',
      });
      const parsed = parsePluginScheduleDeclarations(single, "p");
      expect(parsed.declarations).toEqual([]);
      expect(parsed.errors[0]!.reason).toContain("must be recurring");

      const thrice = makePlugin({
        "thrice.md":
          '---\nexpression: "DTSTART:20260101T090000Z\\nRRULE:FREQ=DAILY;COUNT=3"\nexpression_syntax: rrule\n---\nHi.',
      });
      expect(parsePluginScheduleDeclarations(thrice, "p").errors).toEqual([]);
    });

    test("empty prompt body errors", () => {
      const pluginDir = makePlugin({
        "hollow.md": '---\nexpression: "0 9 * * *"\n---\n   \n',
      });
      const { errors } = parsePluginScheduleDeclarations(pluginDir, "p");
      expect(errors[0]!.reason).toContain("prompt body is empty");
    });

    test("one bad declaration never blocks siblings", () => {
      const pluginDir = makePlugin({
        "bad.md": "---\nexpression: nonsense\n---\nPrompt.",
        "good.md": '---\nexpression: "0 9 * * *"\n---\nPrompt.',
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
        "digest.md": FLAT_MD,
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

    test("changes when the flat file body is edited", () => {
      const pluginDir = makePlugin({ "digest.md": FLAT_MD });
      const before = parsePluginScheduleDeclarations(pluginDir, "p")
        .declarations[0]!.definitionHash;
      writeFileSync(
        join(pluginDir, "schedules", "digest.md"),
        FLAT_MD.replace("Summarize the day.", "Summarize the week."),
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
      const body = '---\nexpression: "0 9 * * *"\n---\nSame.';
      const pluginDir = makePlugin({ "a.md": body, "b.md": body });
      const { declarations } = parsePluginScheduleDeclarations(pluginDir, "p");
      expect(declarations[0]!.definitionHash).not.toBe(
        declarations[1]!.definitionHash,
      );
    });
  });
});
