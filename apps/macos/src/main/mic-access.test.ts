import { afterEach, describe, expect, mock, test } from "bun:test";

const getMediaAccessStatusMock = mock(
  (_mediaType: string) => "granted" as string,
);
const askForMediaAccessMock = mock(async (_mediaType: string) => true);
const openExternalMock = mock(async (_url: string) => undefined);
const ipcHandleMock = mock(
  (_channel: string, _listener: (...args: unknown[]) => unknown) => undefined,
);

mock.module("electron", () => ({
  app: { isPackaged: true },
  ipcMain: { handle: ipcHandleMock, on: mock(() => undefined) },
  shell: { openExternal: openExternalMock },
  systemPreferences: {
    getMediaAccessStatus: getMediaAccessStatusMock,
    askForMediaAccess: askForMediaAccessMock,
  },
}));

const { getMicAccessStatus, installMicAccessIpc, requestMicAccess } =
  await import("./mic-access");

const realPlatform = process.platform;
const setPlatform = (platform: NodeJS.Platform): void => {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
};

afterEach(() => {
  setPlatform(realPlatform);
  getMediaAccessStatusMock.mockClear();
  askForMediaAccessMock.mockClear();
  openExternalMock.mockClear();
});

describe("getMicAccessStatus", () => {
  test("reads the TCC state from systemPreferences on macOS", () => {
    setPlatform("darwin");
    getMediaAccessStatusMock.mockReturnValueOnce("denied");

    expect(getMicAccessStatus()).toBe("denied");
    expect(getMediaAccessStatusMock).toHaveBeenCalledWith("microphone");
  });

  test("reports granted on Linux, which has no TCC equivalent", () => {
    setPlatform("linux");

    expect(getMicAccessStatus()).toBe("granted");
    expect(getMediaAccessStatusMock).not.toHaveBeenCalled();
  });
});

describe("requestMicAccess", () => {
  test("fires the one-shot system prompt on macOS", async () => {
    setPlatform("darwin");
    askForMediaAccessMock.mockResolvedValueOnce(false);

    await expect(requestMicAccess()).resolves.toBe(false);
    expect(askForMediaAccessMock).toHaveBeenCalledWith("microphone");
  });

  test("derives the grant from the access status off macOS", async () => {
    setPlatform("win32");
    getMediaAccessStatusMock.mockReturnValueOnce("denied");

    await expect(requestMicAccess()).resolves.toBe(false);
    expect(askForMediaAccessMock).not.toHaveBeenCalled();
  });
});

describe("installMicAccessIpc", () => {
  test("registers the three mic channels once", () => {
    installMicAccessIpc();
    installMicAccessIpc();

    const channels = ipcHandleMock.mock.calls.map((call) => call[0]);
    expect(channels).toEqual([
      "vellum:mic:getStatus",
      "vellum:mic:request",
      "vellum:mic:openSettings",
    ]);
  });
});
