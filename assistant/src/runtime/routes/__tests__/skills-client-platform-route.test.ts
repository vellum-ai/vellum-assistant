import { beforeEach, describe, expect, mock, test } from "bun:test";

const listSkillsMock = mock((_clientOs?: string) => []);
const listSkillsFilteredMock = mock(
  async (_filter: unknown, _clientOs?: string) => ({
    skills: [],
    categoryCounts: {},
    totalCount: 0,
  }),
);
const searchSkillsMock = mock(
  async (_query: string, _limit: number, _clientOs?: string) => ({
    success: true as const,
    skills: [],
  }),
);
const installSkillMock = mock(async (_spec: Record<string, unknown>) => ({
  success: true as const,
  skillId: "windows-automation",
}));

mock.module("../../../daemon/handlers/skills.js", () => ({
  listSkills: listSkillsMock,
  listSkillsFiltered: listSkillsFilteredMock,
  searchSkills: searchSkillsMock,
  installSkill: installSkillMock,
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
  skillExistsLocally: mock(),
  uninstallSkill: mock(),
  updateSkill: mock(),
}));

const { ROUTES } = await import("../skills-routes.js");

const listHandler = ROUTES.find((r) => r.operationId === "listSkills")!.handler;
const searchHandler = ROUTES.find(
  (r) => r.operationId === "searchSkills",
)!.handler;
const installHandler = ROUTES.find(
  (r) => r.operationId === "installSkill",
)!.handler;

const WINDOWS_HEADERS = { "x-vellum-client-os": "windows" };

beforeEach(() => {
  listSkillsMock.mockClear();
  listSkillsFilteredMock.mockClear();
  searchSkillsMock.mockClear();
  installSkillMock.mockClear();
});

describe("skill management client platform routing", () => {
  test("passes the requesting client OS to skill listings", async () => {
    await listHandler({ headers: WINDOWS_HEADERS });

    expect(listSkillsMock).toHaveBeenCalledWith("windows");
  });

  test("passes the requesting client OS to catalog search", async () => {
    await searchHandler({
      queryParams: { q: "automation" },
      headers: WINDOWS_HEADERS,
    });

    expect(searchSkillsMock).toHaveBeenCalledWith("automation", 25, "windows");
  });

  test("passes the requesting client OS to catalog install", async () => {
    await installHandler({
      body: { slug: "windows-automation" },
      headers: WINDOWS_HEADERS,
    });

    expect(installSkillMock).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "windows-automation",
        clientOs: "windows",
      }),
    );
  });
});
