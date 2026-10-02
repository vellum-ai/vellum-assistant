import { beforeEach, describe, expect, mock, test } from "bun:test";

const healthzMock = mock(
  async (): Promise<
    { ok: true; data: { version?: string } } | { ok: false }
  > => ({ ok: true, data: { version: "1.2.3" } }),
);
const requestUploadMock = mock(
  async (_version: string | undefined, _consumer?: string) => ({
    url: "https://storage.example.com/upload",
    bundleKey: "uploads/org-abc/bundle.vbundle",
    expiresAt: "2026-10-02T00:00:00Z",
  }),
);
const exportMock = mock(
  async (_assistantId: string, _uploadUrl: string) => "job-1",
);
const pollMock = mock(
  async (_assistantId: string, _jobId: string) => "complete",
);

mock.module("@/assistant/api", () => ({
  getAssistantHealthz: healthzMock,
}));
mock.module("./platform-migration-client", () => ({
  requestSignedUploadUrl: requestUploadMock,
}));
mock.module("./teleport-gateway-client", () => ({
  exportManagedToGcs: exportMock,
  pollManagedExportJob: pollMock,
}));

const { exportBundleFilename, exportManagedBundle } = await import(
  "./managed-export"
);
const { TeleportError } = await import("./teleport-types");

const FAST = { pollIntervalMs: 1, timeoutMs: 200 };

beforeEach(() => {
  healthzMock.mockReset();
  healthzMock.mockResolvedValue({ ok: true, data: { version: "1.2.3" } });
  requestUploadMock.mockClear();
  exportMock.mockClear();
  pollMock.mockReset();
  pollMock.mockResolvedValue("complete");
});

describe("exportManagedBundle", () => {
  test("exports through a runtime upload URL stamped with the runtime version", async () => {
    const steps: string[] = [];

    const result = await exportManagedBundle("ast-1", {
      ...FAST,
      onStep: (step) => steps.push(step),
    });

    expect(result).toEqual({
      bundleKey: "uploads/org-abc/bundle.vbundle",
      runtimeVersion: "1.2.3",
    });
    expect(requestUploadMock).toHaveBeenCalledWith("1.2.3", "runtime");
    expect(exportMock).toHaveBeenCalledWith(
      "ast-1",
      "https://storage.example.com/upload",
    );
    expect(steps).toEqual(["preparing", "exporting"]);
  });

  test("keeps polling until the export job completes", async () => {
    pollMock.mockResolvedValueOnce("processing");
    pollMock.mockResolvedValueOnce("processing");

    await exportManagedBundle("ast-1", FAST);

    expect(pollMock).toHaveBeenCalledTimes(3);
  });

  test("an unreadable runtime version leaves the bundle unstamped", async () => {
    healthzMock.mockResolvedValue({ ok: false });

    const result = await exportManagedBundle("ast-1", FAST);

    expect(result.runtimeVersion).toBeUndefined();
    expect(requestUploadMock).toHaveBeenCalledWith(undefined, "runtime");
  });

  test("times out when the export job never completes", async () => {
    pollMock.mockResolvedValue("processing");

    const promise = exportManagedBundle("ast-1", {
      pollIntervalMs: 1,
      timeoutMs: 20,
    });

    await expect(promise).rejects.toBeInstanceOf(TeleportError);
    await expect(promise).rejects.toMatchObject({ code: "export_timed_out" });
  });
});

describe("exportBundleFilename", () => {
  const DATE = new Date("2026-10-02T15:30:00Z");

  test("appends the UTC date and the bundle extension", () => {
    expect(exportBundleFilename("ast-123", DATE)).toBe(
      "ast-123-2026-10-02.vbundle",
    );
  });

  test("replaces characters the platform rejects", () => {
    expect(exportBundleFilename("My Assistant/v2", DATE)).toBe(
      "My-Assistant-v2-2026-10-02.vbundle",
    );
  });

  test("strips a leading non-alphanumeric character", () => {
    expect(exportBundleFilename("..hidden", DATE)).toBe(
      "hidden-2026-10-02.vbundle",
    );
  });

  test("falls back to a generic label when nothing usable remains", () => {
    expect(exportBundleFilename("???", DATE)).toBe(
      "assistant-2026-10-02.vbundle",
    );
  });

  test("caps the label length within the platform's 128-char limit", () => {
    const filename = exportBundleFilename("a".repeat(500), DATE);
    expect(filename.length).toBeLessThanOrEqual(128);
    expect(filename).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  });
});
