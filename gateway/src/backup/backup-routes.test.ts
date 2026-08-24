import { expect, mock, test } from "bun:test";

const listedDirectories: string[] = [];

mock.module("../config-file-utils.js", () => ({
  readConfigFileOrEmpty: () => ({
    backup: {
      localDirectory: "/local",
      offsite: { enabled: true, destinations: null },
    },
  }),
}));

mock.module("./platform-paths.js", () => ({
  resolveOffsiteDestinations: () => [
    { path: "/platform-default", encrypt: true },
  ],
}));

mock.module("./list-snapshots.js", () => ({
  listSnapshotsInDir: async (directory: string) => {
    listedDirectories.push(directory);
    return [];
  },
}));

mock.module("./backup-worker.js", () => ({
  createSnapshotNow: async () => {
    throw new Error("not used");
  },
}));

const { createListBackupsHandler } = await import("./backup-routes.js");

test("lists the gateway-owned platform default", async () => {
  const handler = createListBackupsHandler({
    assistantRuntimeBaseUrl: "http://assistant.internal",
  });

  const response = await handler(new Request("http://gateway/v1/backups"));
  const body = (await response.json()) as {
    offsite: Array<{
      directory: string;
      encrypted: boolean;
      snapshots: unknown[];
    }>;
  };

  expect(response.status).toBe(200);
  expect(body.offsite).toEqual([
    { directory: "/platform-default", encrypted: true, snapshots: [] },
  ]);
  expect(listedDirectories).toEqual(["/local", "/platform-default"]);
});
