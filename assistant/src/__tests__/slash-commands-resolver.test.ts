import { describe, expect, test } from "bun:test";

import type { ResolvedSkill } from "../config/skill-state.js";
import type { SkillSummary } from "../config/skills.js";
import {
  buildInvocableSlashCatalog,
  formatUnknownSlashSkillMessage,
  type InvocableSlashSkill,
  resolveSlashSkillCommand,
} from "../skills/slash-commands.js";

function makeSkill(
  id: string,
  overrides?: Partial<SkillSummary>,
): SkillSummary {
  return {
    id,
    name: overrides?.name ?? id,
    displayName: overrides?.displayName ?? overrides?.name ?? id,
    description: `Description for ${id}`,
    directoryPath: `/skills/${id}`,
    skillFilePath: `/skills/${id}/SKILL.md`,
    userInvocable: overrides?.userInvocable ?? true,
    disableModelInvocation: false,
    source: "managed",
  };
}

function makeResolved(
  skill: SkillSummary,
  state: ResolvedSkill["state"],
): ResolvedSkill {
  return {
    summary: skill,
    state,
    degraded: state === "degraded",
  };
}

function buildCatalog(
  skills: SkillSummary[],
): Map<string, InvocableSlashSkill> {
  const resolved = skills.map((s) => makeResolved(s, "enabled"));
  return buildInvocableSlashCatalog(skills, resolved);
}

describe("resolveSlashSkillCommand", () => {
  test("returns none for normal text", () => {
    const catalog = buildCatalog([makeSkill("start-the-day")]);
    expect(resolveSlashSkillCommand("hello world", catalog)).toEqual({
      kind: "none",
    });
  });

  test("returns none for empty input", () => {
    const catalog = buildCatalog([]);
    expect(resolveSlashSkillCommand("", catalog)).toEqual({ kind: "none" });
  });

  test("returns none for path-like /tmp/file", () => {
    const catalog = buildCatalog([makeSkill("tmp")]);
    expect(resolveSlashSkillCommand("/tmp/file", catalog)).toEqual({
      kind: "none",
    });
  });

  test("returns known for exact ID match", () => {
    const catalog = buildCatalog([makeSkill("start-the-day")]);
    const result = resolveSlashSkillCommand("/start-the-day", catalog);
    expect(result).toEqual({
      kind: "known",
      skillId: "start-the-day",
      trailingArgs: "",
    });
  });

  test("returns known with trailing args", () => {
    const catalog = buildCatalog([makeSkill("start-the-day")]);
    const result = resolveSlashSkillCommand(
      "/start-the-day weather in SF",
      catalog,
    );
    expect(result).toEqual({
      kind: "known",
      skillId: "start-the-day",
      trailingArgs: "weather in SF",
    });
  });

  test("known match is case-insensitive but returns canonical ID", () => {
    const catalog = buildCatalog([makeSkill("Start-The-Day")]);
    const result = resolveSlashSkillCommand("/start-the-day", catalog);
    expect(result.kind).toBe("known");
    if (result.kind === "known") {
      expect(result.skillId).toBe("Start-The-Day");
    }
  });

  test("returns unknown for unrecognized slash command", () => {
    const catalog = buildCatalog([makeSkill("start-the-day")]);
    const result = resolveSlashSkillCommand("/not-a-skill", catalog);
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.requestedId).toBe("not-a-skill");
      expect(result.message).toContain("Unknown command `/not-a-skill`");
      expect(result.message).toContain("`/start-the-day`");
    }
  });

  test("unknown message lists available skills sorted", () => {
    const catalog = buildCatalog([
      makeSkill("zebra"),
      makeSkill("alpha"),
      makeSkill("mid"),
    ]);
    const result = resolveSlashSkillCommand("/nope", catalog);
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      const lines = result.message.split("\n");
      const skillLines = lines.filter((l) => l.startsWith("- `"));
      expect(skillLines[0]).toContain("/alpha");
      expect(skillLines[1]).toContain("/mid");
      expect(skillLines[2]).toContain("/zebra");
    }
  });

  test("handles leading whitespace in input", () => {
    const catalog = buildCatalog([makeSkill("start-the-day")]);
    const result = resolveSlashSkillCommand(
      "   /start-the-day   foo bar",
      catalog,
    );
    expect(result).toEqual({
      kind: "known",
      skillId: "start-the-day",
      trailingArgs: "foo bar",
    });
  });
});

describe("browser skill slash discoverability", () => {
  const browserSkill = makeSkill("browser", {
    name: "Browser",
    userInvocable: true,
  });

  test("/browser resolves as a known slash command when browser skill is enabled", () => {
    const catalog = buildCatalog([browserSkill]);
    const result = resolveSlashSkillCommand("/browser", catalog);
    expect(result).toEqual({
      kind: "known",
      skillId: "browser",
      trailingArgs: "",
    });
  });

  test("/browser shows correct skill metadata", () => {
    const catalog = buildCatalog([browserSkill]);
    const entry = catalog.get("browser");
    expect(entry).toBeDefined();
    expect(entry!.canonicalId).toBe("browser");
    expect(entry!.name).toBe("Browser");
    expect(entry!.summary.userInvocable).toBe(true);
    expect(entry!.summary.description).toBe("Description for browser");
  });

  test("/browser resolves with trailing args", () => {
    const catalog = buildCatalog([browserSkill]);
    const result = resolveSlashSkillCommand(
      "/browser go to https://example.com",
      catalog,
    );
    expect(result).toEqual({
      kind: "known",
      skillId: "browser",
      trailingArgs: "go to https://example.com",
    });
  });

  test("/browser is excluded when userInvocable is false", () => {
    const nonInvocable = makeSkill("browser", {
      name: "Browser",
      userInvocable: false,
    });
    const catalog = buildCatalog([nonInvocable]);
    const result = resolveSlashSkillCommand("/browser", catalog);
    expect(result.kind).toBe("unknown");
  });

  test("/browser appears in available commands when unknown command is entered", () => {
    const catalog = buildCatalog([browserSkill, makeSkill("start-the-day")]);
    const result = resolveSlashSkillCommand("/not-a-command", catalog);
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.message).toContain("`/browser`");
      expect(result.message).toContain("`/start-the-day`");
    }
  });

  test("/browser sorts correctly among other skills in unknown listing", () => {
    const catalog = buildCatalog([
      makeSkill("weather"),
      browserSkill,
      makeSkill("agentmail"),
    ]);
    const result = resolveSlashSkillCommand("/nope", catalog);
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      const lines = result.message.split("\n");
      const skillLines = lines.filter((l) => l.startsWith("- `"));
      expect(skillLines[0]).toContain("/agentmail");
      expect(skillLines[1]).toContain("/browser");
      expect(skillLines[2]).toContain("/weather");
    }
  });
});

describe("formatUnknownSlashSkillMessage", () => {
  test("includes requested ID and available skills", () => {
    const msg = formatUnknownSlashSkillMessage("bad-cmd", ["alpha", "beta"]);
    expect(msg).toContain("Unknown command `/bad-cmd`");
    expect(msg).toContain("- `/alpha`");
    expect(msg).toContain("- `/beta`");
  });

  test("shows no-commands message when catalog is empty", () => {
    const msg = formatUnknownSlashSkillMessage("bad-cmd", []);
    expect(msg).toContain("Unknown command `/bad-cmd`");
    expect(msg).toContain("No slash commands are currently available.");
  });
});
