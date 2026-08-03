import { afterEach, expect, mock, test } from "bun:test";

let exportRequested = false;
const originalIsPlatform = process.env.IS_PLATFORM;

mock.module("../config-file-utils.js", () => ({
  readConfigFileOrEmpty: () => ({
    backup: {
      enabled: true,
      intervalHours: 1,
      retention: 3,
      offsite: { enabled: false },
    },
  }),
}));

mock.module("../fetch.js", () => ({
  fetchImpl: async () => {
    exportRequested = true;
    throw new Error("Platform backup export must not be requested");
  },
}));

afterEach(() => {
  if (originalIsPlatform === undefined) {
    delete process.env.IS_PLATFORM;
  } else {
    process.env.IS_PLATFORM = originalIsPlatform;
  }
  mock.restore();
});

test("platform mode disables the backup worker", async () => {
  process.env.IS_PLATFORM = "true";
  const { startBackupWorker } = await import("../backup/backup-worker.js");

  const worker = startBackupWorker({
    assistantRuntimeBaseUrl: "http://127.0.0.1:7821",
  });
  await worker.runOnce();
  worker.stop();

  expect(exportRequested).toBeFalse();
});
