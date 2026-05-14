import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = mkdtempSync(join(tmpdir(), "cli-client-test-"));
const xdgConfigHome = mkdtempSync(join(tmpdir(), "cli-client-xdg-test-"));
process.env.VELLUM_LOCKFILE_DIR = testDir;
process.env.XDG_CONFIG_HOME = xdgConfigHome;

const renderChatAppMock = mock(() => ({
  handle: {},
  unmount: () => {},
}));

mock.module("../components/DefaultMainScreen", () => ({
  renderChatApp: renderChatAppMock,
}));

import * as assistantConfig from "../lib/assistant-config.js";
import * as platformClient from "../lib/platform-client.js";
import { tuiLog } from "../lib/tui-log";
import { client } from "../commands/client.js";

const saveAssistantEntryMock = spyOn(
  assistantConfig,
  "saveAssistantEntry",
).mockImplementation(() => {});

const fetchPlatformAssistantsMock = spyOn(
  platformClient,
  "fetchPlatformAssistants",
).mockResolvedValue([]);

const fetchOrganizationIdMock = spyOn(
  platformClient,
  "fetchOrganizationId",
).mockResolvedValue("org-1");

const readPlatformTokenMock = spyOn(
  platformClient,
  "readPlatformToken",
).mockReturnValue("platform-token");

const tuiLogInitMock = spyOn(tuiLog, "init").mockImplementation(() => {});
const tuiLogInfoMock = spyOn(tuiLog, "info").mockImplementation(() => {});
const tuiLogCloseMock = spyOn(tuiLog, "close").mockImplementation(() => {});

const ASSISTANT_ID = "019d3011-97c7-7541-b49a-ef11aaedfe79";

function writeLockfile(extraEntry: Record<string, unknown> = {}): void {
  writeFileSync(
    join(testDir, ".vellum.lock.json"),
    JSON.stringify(
      {
        assistants: [
          {
            assistantId: ASSISTANT_ID,
            runtimeUrl: "https://platform.vellum.ai",
            cloud: "vellum",
            species: "vellum",
            ...extraEntry,
          },
        ],
        activeAssistant: ASSISTANT_ID,
      },
      null,
      2,
    ),
  );
}

describe("client command", () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = [...process.argv];
    renderChatAppMock.mockClear();
    renderChatAppMock.mockReturnValue({
      handle: {},
      unmount: () => {},
    });
    saveAssistantEntryMock.mockClear();
    fetchPlatformAssistantsMock.mockReset();
    fetchPlatformAssistantsMock.mockResolvedValue([]);
    fetchOrganizationIdMock.mockReset();
    fetchOrganizationIdMock.mockResolvedValue("org-1");
    readPlatformTokenMock.mockReset();
    readPlatformTokenMock.mockReturnValue("platform-token");
    tuiLogInitMock.mockClear();
    tuiLogInfoMock.mockClear();
    tuiLogCloseMock.mockClear();
    process.argv = ["bun", "vellum", "client"];
  });

  afterAll(() => {
    process.argv = originalArgv;
    delete process.env.VELLUM_LOCKFILE_DIR;
    delete process.env.XDG_CONFIG_HOME;
    rmSync(testDir, { recursive: true, force: true });
    rmSync(xdgConfigHome, { recursive: true, force: true });
    saveAssistantEntryMock.mockRestore();
    fetchPlatformAssistantsMock.mockRestore();
    fetchOrganizationIdMock.mockRestore();
    readPlatformTokenMock.mockRestore();
    tuiLogInitMock.mockRestore();
    tuiLogInfoMock.mockRestore();
    tuiLogCloseMock.mockRestore();
  });

  test("hydrates a missing platform assistant name before the first render", async () => {
    writeLockfile();
    fetchPlatformAssistantsMock.mockResolvedValue([
      {
        id: ASSISTANT_ID,
        name: "David Rose",
        status: "active",
      },
    ]);

    await client();

    expect(fetchPlatformAssistantsMock).toHaveBeenCalledWith("platform-token");
    expect(saveAssistantEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantId: ASSISTANT_ID,
        name: "David Rose",
      }),
    );
    expect(renderChatAppMock).toHaveBeenCalledWith(
      "https://platform.vellum.ai",
      ASSISTANT_ID,
      "vellum",
      expect.any(Function),
      expect.objectContaining({
        assistantName: "David Rose",
        auth: expect.objectContaining({
          "X-Session-Token": "platform-token",
          "Vellum-Organization-Id": "org-1",
        }),
      }),
    );
  });
});
