import { beforeEach, describe, expect, mock, test } from "bun:test";

import * as daemonSdk from "@/generated/daemon/sdk.gen";

type ContentResult = { data: Blob | null; error: { message: string } | null };

type ContentRequest = {
  path: { assistant_id: string };
  query: { path: string; showHidden?: string };
  parseAs: string;
};

const workspaceFileContentGet = mock(
  async (_request: ContentRequest): Promise<ContentResult> => ({
    data: new Blob(["binary"]),
    error: null,
  }),
);

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  workspaceFileContentGet,
}));

const saveFile = mock(
  async (_source: Blob | string, _filename: string): Promise<void> =>
    undefined,
);

mock.module("@/runtime/native-file", () => ({ saveFile }));

const { downloadWorkspaceFile } = await import(
  "@/domains/workspace/utils/download-workspace-file"
);

describe("downloadWorkspaceFile", () => {
  beforeEach(() => {
    workspaceFileContentGet.mockClear();
    saveFile.mockClear();
  });

  test("fetches content and hands the blob to the saver", async () => {
    await downloadWorkspaceFile({
      assistantId: "asst-1",
      path: "exports/report.tar.gz",
      filename: "report.tar.gz",
    });

    expect(workspaceFileContentGet).toHaveBeenCalledTimes(1);
    const call = workspaceFileContentGet.mock.calls[0]![0];
    expect(call.path.assistant_id).toBe("asst-1");
    expect(call.query.path).toBe("exports/report.tar.gz");
    expect(call.query.showHidden).toBeUndefined();
    expect(call.parseAs).toBe("blob");

    expect(saveFile).toHaveBeenCalledTimes(1);
    const [blob, filename] = saveFile.mock.calls[0]!;
    expect(blob).toBeInstanceOf(Blob);
    expect(filename).toBe("report.tar.gz");
  });

  test("forwards showHidden when set", async () => {
    await downloadWorkspaceFile({
      assistantId: "asst-1",
      path: ".secret/key.bin",
      filename: "key.bin",
      showHidden: true,
    });

    const call = workspaceFileContentGet.mock.calls[0]![0];
    expect(call.query.showHidden).toBe("true");
  });

  test("throws and never saves when the endpoint errors", async () => {
    workspaceFileContentGet.mockResolvedValueOnce({
      data: null,
      error: { message: "boom" },
    });

    await expect(
      downloadWorkspaceFile({
        assistantId: "asst-1",
        path: "exports/report.tar.gz",
        filename: "report.tar.gz",
      }),
    ).rejects.toThrow("Failed to download file");

    expect(saveFile).not.toHaveBeenCalled();
  });
});
