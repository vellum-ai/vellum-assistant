import { z } from "zod";

import {
  ClientRegistry,
  getClientRegistry,
} from "../../runtime/client-registry.js";
import type { IpcRoute } from "../cli-server.js";

const ListClientsParams = z
  .object({
    capability: z.string().optional(),
  })
  .optional();

export const listClientsRoute: IpcRoute = {
  method: "list_clients",
  handler: async (params) => {
    const parsed = ListClientsParams.parse(params);
    const registry = getClientRegistry();

    const entries = parsed?.capability
      ? registry.listByCapability(
          parsed.capability as Parameters<typeof registry.listByCapability>[0],
        )
      : registry.listAll();

    return {
      clients: entries.map((e) => ClientRegistry.toJSON(e)),
    };
  },
};
