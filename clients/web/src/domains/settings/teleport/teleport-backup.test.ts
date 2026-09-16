import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { LockfileAssistant } from "@/runtime/local-mode-host";

type SdkResult = {
  data?: unknown;
  error?: unknown;
  response?: { ok: boolean; status: number };
};

const retrieveMock = mock(
  async (): Promise<SdkResult> => ({
    data: { backups: [] },
    response: { ok: true, status: 200 },
  }),
);
const createMock = mock(
  async (): Promise<SdkResult> => ({
    data: { snapshot_name: "snap-1", ready_to_use: false },
    response: { ok: true, status: 201 },
  }),
);
const createLocalBackupMock = mock(async (_assistant: LockfileAssistant) => {});

mock.module("@/generated/api/sdk.gen", () => ({
  assistantsBackupsRetrieve: retrieveMock,
  assistantsBackupsCreate: createMock,
}));
mock.module("./teleport-gateway-client", () => ({
  createLocalBackup: createLocalBackupMock,
}));

const { ensureSourceBackup } = await import("./teleport-backup");
const { TeleportError } = await import("./teleport-types");

const MANAGED = {
  assistantId: "ast-managed",
  cloud: "vellum",
} as unknown as LockfileAssistant;
const LOCAL = {
  assistantId: "ast-local",
  cloud: "local",
} as unknown as LockfileAssistant;

const FAST = { readyPollIntervalMs: 1, readyTimeoutMs: 200 };

function listing(backups: unknown[]): SdkResult {
  return { data: { backups }, response: { ok: true, status: 200 } };
}

beforeEach(() => {
  retrieveMock.mockReset();
  retrieveMock.mockResolvedValue(listing([]));
  createMock.mockReset();
  createMock.mockResolvedValue({
    data: { snapshot_name: "snap-1", ready_to_use: false },
    response: { ok: true, status: 201 },
  });
  createLocalBackupMock.mockReset();
  createLocalBackupMock.mockResolvedValue(undefined);
});

describe("ensureSourceBackup (managed)", () => {
  test("reuses a recent ready snapshot without creating one", async () => {
    retrieveMock.mockResolvedValue(
      listing([
        {
          snapshot_name: "recent",
          created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
          ready_to_use: true,
        },
      ]),
    );

    await ensureSourceBackup(MANAGED, FAST);

    expect(createMock).not.toHaveBeenCalled();
  });

  test("a recent but pending snapshot does not count", async () => {
    retrieveMock
      .mockResolvedValueOnce(
        listing([
          {
            snapshot_name: "pending",
            created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
            ready_to_use: false,
          },
        ]),
      )
      .mockResolvedValue(
        listing([{ snapshot_name: "snap-1", ready_to_use: true }]),
      );

    await ensureSourceBackup(MANAGED, FAST);

    expect(createMock).toHaveBeenCalledTimes(1);
  });

  test("creates a snapshot and waits until the listing reports it ready", async () => {
    retrieveMock
      .mockResolvedValueOnce(listing([]))
      .mockResolvedValueOnce(
        listing([{ snapshot_name: "snap-1", ready_to_use: false }]),
      )
      .mockResolvedValue(
        listing([{ snapshot_name: "snap-1", ready_to_use: true }]),
      );

    await ensureSourceBackup(MANAGED, FAST);

    expect(createMock).toHaveBeenCalledWith({
      path: { assistant_id: "ast-managed" },
      throwOnError: false,
    });
    expect(retrieveMock).toHaveBeenCalledTimes(3);
  });

  test("returns without polling when the POST already reports ready", async () => {
    createMock.mockResolvedValue({
      data: { snapshot_name: "snap-1", ready_to_use: true },
      response: { ok: true, status: 201 },
    });

    await ensureSourceBackup(MANAGED, FAST);

    expect(retrieveMock).toHaveBeenCalledTimes(1);
  });

  test("fails when the snapshot never becomes ready", async () => {
    retrieveMock.mockResolvedValue(
      listing([{ snapshot_name: "snap-1", ready_to_use: false }]),
    );

    const error = await ensureSourceBackup(MANAGED, {
      readyPollIntervalMs: 1,
      readyTimeoutMs: 20,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(TeleportError);
    expect((error as InstanceType<typeof TeleportError>).code).toBe(
      "backup_failed",
    );
    expect((error as Error).message).toContain("not ready");
  });

  test("fails when the POST is rejected", async () => {
    createMock.mockResolvedValue({
      data: undefined,
      error: { detail: "Bad gateway" },
      response: { ok: false, status: 502 },
    });

    const error = await ensureSourceBackup(MANAGED, FAST).catch(
      (err: unknown) => err,
    );

    expect((error as InstanceType<typeof TeleportError>).code).toBe(
      "backup_failed",
    );
    expect((error as Error).message).toContain("502");
  });

  test("fails when the listing cannot be read", async () => {
    retrieveMock.mockResolvedValue({
      data: undefined,
      error: { detail: "Bad gateway" },
      response: { ok: false, status: 502 },
    });

    const error = await ensureSourceBackup(MANAGED, FAST).catch(
      (err: unknown) => err,
    );

    expect((error as InstanceType<typeof TeleportError>).code).toBe(
      "backup_failed",
    );
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("ensureSourceBackup (local)", () => {
  test("always takes a gateway snapshot", async () => {
    await ensureSourceBackup(LOCAL, FAST);

    expect(createLocalBackupMock).toHaveBeenCalledWith(LOCAL);
    expect(retrieveMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  test("propagates a gateway snapshot failure", async () => {
    createLocalBackupMock.mockRejectedValue(
      new TeleportError("backup_failed", "Backup failed (HTTP 500)."),
    );

    await expect(ensureSourceBackup(LOCAL, FAST)).rejects.toThrow(
      "Backup failed (HTTP 500).",
    );
  });
});

describe("ensureSourceBackup (other hosting)", () => {
  test("refuses sources with no backup transport", async () => {
    const other = {
      assistantId: "ast-other",
      cloud: "apple-container",
    } as unknown as LockfileAssistant;

    await expect(ensureSourceBackup(other, FAST)).rejects.toThrow(
      "cannot be backed up",
    );
  });
});
