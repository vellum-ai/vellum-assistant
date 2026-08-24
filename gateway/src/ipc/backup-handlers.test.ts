import { expect, test } from "bun:test";

import {
  DefaultBackupDestinationsIpcResponseSchema,
  GET_DEFAULT_BACKUP_DESTINATIONS_IPC_METHOD,
} from "@vellumai/gateway-client/gateway-ipc-contracts";

import { backupRoutes } from "./backup-handlers.js";

test("registers the typed default backup destinations route", async () => {
  const [route] = backupRoutes;
  expect(route?.method).toBe(GET_DEFAULT_BACKUP_DESTINATIONS_IPC_METHOD);

  const response = await route?.handler();
  expect(
    DefaultBackupDestinationsIpcResponseSchema.safeParse(response).success,
  ).toBeTrue();
});
