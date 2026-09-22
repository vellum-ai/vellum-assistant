import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

const WORKSPACE_DIR = mkdtempSync(join(tmpdir(), "skill-md-mtime-refresh-"));
process.env.VELLUM_WORKSPACE_DIR = WORKSPACE_DIR;

const seedGraphCalls: number[] = [];
const seedV2Calls: number[] = [];

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({}),
}));

mock.module("../../plugins/defaults/memory/graph/capability-seed.js", () => ({
  seedSkillGraphNodes: () => {
    seedGraphCalls.push(Date.now());
  },
  seedUninstalledCatalogSkillMemories: async () => {},
}));

mock.module(
  "../../plugins/defaults/memory/substrate/boot-maintenance.js",
  () => ({
    maybeSeedCapabilitySkills: () => {
      seedV2Calls.push(Date.now());
    },
    maybeSeedCliCommandCards: () => {},
  }),
);

const {
  _resetSkillMdMtimeStateForTests,
  maybeRefreshSkillCapabilityMemoriesFromMtime,
  refreshSkillCapabilityMemories,
  startWorkspaceSkillMdMtimePoll,
  stopWorkspaceSkillMdMtimePoll,
} = await import("../skill-memory-refresh.js");

const SKILLS_DIR = join(WORKSPACE_DIR, "skills");

function writeSkill(id: string): string {
  const dir = join(SKILLS_DIR, id);
  mkdirSync(dir, { recursive: true });
  const skillMd = join(dir, "SKILL.md");
  writeFileSync(
    skillMd,
    `---\nname: ${id}\ndescription: ${id}\n---\nbody\n`,
  );
  return skillMd;
}

describe("maybeRefreshSkillCapabilityMemoriesFromMtime", () => {
  beforeEach(() => {
    rmSync(SKILLS_DIR, { recursive: true, force: true });
    mkdirSync(SKILLS_DIR, { recursive: true });
    seedGraphCalls.length = 0;
    seedV2Calls.length = 0;
    _resetSkillMdMtimeStateForTests();
  });

  afterEach(() => {
    _resetSkillMdMtimeStateForTests();
  });

  test("first call reseeds, a second call with unchanged SKILL.md does not", () => {
    writeSkill("alpha");
    expect(maybeRefreshSkillCapabilityMemoriesFromMtime()).toBe(true);
    expect(seedGraphCalls).toHaveLength(1);
    expect(seedV2Calls).toHaveLength(1);

    expect(maybeRefreshSkillCapabilityMemoriesFromMtime()).toBe(false);
    expect(seedGraphCalls).toHaveLength(1);
  });

  test("explicit refresh remembers the signature so the next poll is a no-op", () => {
    writeSkill("alpha");
    refreshSkillCapabilityMemories();
    expect(seedGraphCalls).toHaveLength(1);
    expect(maybeRefreshSkillCapabilityMemoriesFromMtime()).toBe(false);
  });

  test("SKILL.md mtime change reseeds", () => {
    const skillMd = writeSkill("alpha");
    expect(maybeRefreshSkillCapabilityMemoriesFromMtime()).toBe(true);

    const later = new Date(Date.now() + 5_000);
    utimesSync(skillMd, later, later);
    expect(maybeRefreshSkillCapabilityMemoriesFromMtime()).toBe(true);
    expect(seedGraphCalls).toHaveLength(2);
  });

  test("TOOLS.json change without a SKILL.md mtime change does not reseed", () => {
    writeSkill("alpha");
    expect(maybeRefreshSkillCapabilityMemoriesFromMtime()).toBe(true);

    writeFileSync(
      join(SKILLS_DIR, "alpha", "TOOLS.json"),
      JSON.stringify({ version: 1, tools: [] }),
    );
    expect(maybeRefreshSkillCapabilityMemoriesFromMtime()).toBe(false);
    expect(seedGraphCalls).toHaveLength(1);
  });

  test("adding or removing a skill directory reseeds", () => {
    writeSkill("alpha");
    expect(maybeRefreshSkillCapabilityMemoriesFromMtime()).toBe(true);

    writeSkill("bravo");
    expect(maybeRefreshSkillCapabilityMemoriesFromMtime()).toBe(true);

    rmSync(join(SKILLS_DIR, "bravo"), { recursive: true, force: true });
    expect(maybeRefreshSkillCapabilityMemoriesFromMtime()).toBe(true);
    expect(seedGraphCalls).toHaveLength(3);
  });

  test("startWorkspaceSkillMdMtimePoll runs once immediately and is idempotent", () => {
    writeSkill("alpha");
    startWorkspaceSkillMdMtimePoll();
    expect(seedGraphCalls).toHaveLength(1);
    startWorkspaceSkillMdMtimePoll();
    expect(seedGraphCalls).toHaveLength(1);
    stopWorkspaceSkillMdMtimePoll();
  });
});
