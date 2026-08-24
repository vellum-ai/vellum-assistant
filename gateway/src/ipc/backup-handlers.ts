import {
  DefaultBackupDestinationsIpcResponseSchema,
  GET_DEFAULT_BACKUP_DESTINATIONS_IPC_METHOD,
} from "@vellumai/gateway-client/gateway-ipc-contracts";

import { resolveDefaultOffsiteDestinations } from "../backup/platform-paths.js";
import type { IpcRoute } from "./server.js";

export const backupRoutes: IpcRoute[] = [
  {
    method: GET_DEFAULT_BACKUP_DESTINATIONS_IPC_METHOD,
    handler: () =>
      DefaultBackupDestinationsIpcResponseSchema.parse({
        destinations: resolveDefaultOffsiteDestinations(),
      }),
  },
];
