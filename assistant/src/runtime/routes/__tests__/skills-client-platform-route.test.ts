import { beforeEach, describe, expect, mock, test } from "bun:test";

const listSkillsMock = mock(
  (_clientOs?: string, _sourceActorPrincipalId?: string) => [],
);
const listSkillsFilteredMock = mock(
  async (
    _filter: unknown,
    _clientOs?: string,
    _sourceActorPrincipalId?: string,
  ) => ({
    skills: [],
    categoryCounts: {},
    totalCount: 0,
  }),
);
const searchSkillsMock = mock(
  async (
    _query: string,
    _limit: number,
    _clientOs?: string,
    _sourceActorPrincipalId?: string,
  ) => ({
    success: true as const,
    skills: [],
  }),
);
const installSkillMock = mock(async (_spec: Record<string, unknown>) => ({
  success: true as const,
  skillId: "windows-automation",
}));
const getSkillLocalDetailMock = mock(() => ({
  ok: true as const,
  skill: {},
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
  getSkillLocalDetail: getSkillLocalDetailMock,
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
const localInspectHandler = ROUTES.find(
  (r) => r.operationId === "skillsLocalInspect",
)!.handler;

const WINDOWS_HEADERS = {
  "x-vellum-client-os": "windows",
  "x-vellum-actor-principal-id": "actor-a",
};

beforeEach(() => {
  listSkillsMock.mockClear();
  listSkillsFilteredMock.mockClear();
  searchSkillsMock.mockClear();
  installSkillMock.mockClear();
  getSkillLocalDetailMock.mockClear();
});

describe("skill management client platform routing", () => {
  test("passes the requesting client OS to skill listings", async () => {
    await listHandler({ headers: WINDOWS_HEADERS });

    expect(listSkillsMock).toHaveBeenCalledWith(
      "windows",
      "actor-a",
      true,
      undefined,
    );
  });

  test("passes the requesting client OS to catalog search", async () => {
    await searchHandler({
      queryParams: { q: "automation" },
      headers: WINDOWS_HEADERS,
    });

    expect(searchSkillsMock).toHaveBeenCalledWith(
      "automation",
      25,
      "windows",
      "actor-a",
      true,
      undefined,
    );
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
        isInteractive: true,
        sourceActorPrincipalId: "actor-a",
      }),
    );
  });

  test("uses the authenticated local IPC host for direct skill commands", async () => {
    const daemonPlatform =
      process.platform === "darwin"
        ? "macos"
        : process.platform === "win32"
          ? "windows"
          : "linux";
    const headers = {
      "x-vellum-principal-type": "local",
      "x-vellum-actor-principal-id": "actor-a",
    };

    await listHandler({ headers });
    await searchHandler({ queryParams: { q: "automation" }, headers });
    await installHandler({ body: { slug: "windows-automation" }, headers });
    await localInspectHandler({
      pathParams: { id: "windows-automation" },
      headers,
    });

    expect(listSkillsMock).toHaveBeenCalledWith(
      daemonPlatform,
      "actor-a",
      true,
      [daemonPlatform],
    );
    expect(searchSkillsMock).toHaveBeenCalledWith(
      "automation",
      25,
      daemonPlatform,
      "actor-a",
      true,
      [daemonPlatform],
    );
    expect(installSkillMock).toHaveBeenCalledWith(
      expect.objectContaining({
        clientOs: daemonPlatform,
        hostPlatforms: [daemonPlatform],
        sourceActorPrincipalId: "actor-a",
      }),
    );
    expect(getSkillLocalDetailMock).toHaveBeenCalledWith(
      "windows-automation",
      daemonPlatform,
      "actor-a",
      true,
      [daemonPlatform],
    );
  });
});
