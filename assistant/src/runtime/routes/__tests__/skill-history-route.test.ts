/**
 * Tests for the `getSkillHistory` route's current-resource boundary.
 *
 * The service layer reads retained git history, which outlives the skill it
 * describes: a deleted skill's commits stay in the workspace repository
 * forever. The route is therefore the only place that can decide whether an id
 * still names something, and it must reach the same answer as the sibling file
 * routes rather than serving history for a resource the rest of the API
 * reports as gone.
 *
 * Both collaborators are mocked, because what is under test is the ordering
 * between them: the existence check has to gate the history read, not run
 * alongside it.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const skillExistsLocallyMock = mock((_id: string): boolean => true);
const getSkillHistoryMock = mock(async (_id: string, _opts?: unknown) => ({
  skillId: _id,
  revisions: [{ id: "abc1234", changedAt: "", files: ["SKILL.md"], diff: "" }],
  truncatedByCompaction: false,
}));

mock.module("../../../daemon/handlers/skills.js", () => ({
  skillExistsLocally: skillExistsLocallyMock,
  // The route module imports the whole handler surface; the rest is unused
  // here and only needs to exist.
  checkSkillUpdates: mock(),
  configureSkill: mock(),
  createSkill: mock(),
  disableSkill: mock(),
  draftSkill: mock(),
  enableSkill: mock(),
  getSkill: mock(),
  getSkillFileContent: mock(),
  getSkillFiles: mock(),
  getSkillLocalDetail: mock(),
  inspectSkill: mock(),
  installSkill: mock(),
  listSkills: mock(),
  listSkillsFiltered: mock(),
  searchSkills: mock(),
  uninstallSkill: mock(),
  updateSkill: mock(),
}));

mock.module("../../../skills/skill-history.js", () => ({
  getSkillHistory: getSkillHistoryMock,
}));

const { ROUTES } = await import("../skills-routes.js");

const handler = ROUTES.find(
  (r) => r.operationId === "getSkillHistory",
)!.handler;

beforeEach(() => {
  skillExistsLocallyMock.mockClear();
  getSkillHistoryMock.mockClear();
  skillExistsLocallyMock.mockImplementation(() => true);
});

describe("getSkillHistory route", () => {
  test("returns history for a skill that currently exists", async () => {
    const result = (await handler({
      pathParams: { id: "release-triage" },
    })) as {
      revisions: unknown[];
    };

    expect(result.revisions).toHaveLength(1);
    expect(getSkillHistoryMock).toHaveBeenCalledTimes(1);
  });

  test("404s for a deleted skill whose commits are still in the repository", async () => {
    // The skill is gone from the resolver, but git would still answer.
    skillExistsLocallyMock.mockImplementation(() => false);

    await expect(
      handler({ pathParams: { id: "release-triage" } }),
    ).rejects.toThrow(/not found/i);
  });

  test("does not read history at all when the skill is gone", async () => {
    skillExistsLocallyMock.mockImplementation(() => false);

    await Promise.resolve(
      handler({ pathParams: { id: "release-triage" } }),
    ).catch(() => {});

    // Ordering is the point: a check that ran after the read would still
    // reject, but would have spent the git traversal to do it.
    expect(getSkillHistoryMock).not.toHaveBeenCalled();
  });

  test("rejects a malformed id as the caller's error, not a server fault", async () => {
    getSkillHistoryMock.mockImplementation(() => {
      throw new Error("Invalid skill id: contains a path separator");
    });

    await expect(handler({ pathParams: { id: "bad" } })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  test("surfaces an unexpected service failure as a server error", async () => {
    getSkillHistoryMock.mockImplementation(() => {
      throw new Error("git exploded");
    });

    await expect(handler({ pathParams: { id: "ok" } })).rejects.toMatchObject({
      statusCode: 500,
    });
  });
});
