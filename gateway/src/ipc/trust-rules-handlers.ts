/**
 * IPC route definitions for gateway-owned trust rules.
 */

import { TrustRulesListIpcParamsSchema } from "@vellumai/gateway-client/gateway-ipc-contracts";

import { listTrustRules } from "../http/routes/trust-rules.js";
import type { IpcRoute } from "./server.js";

export const trustRulesRoutes: IpcRoute[] = [
  {
    method: "trust_rules_list",
    schema: TrustRulesListIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const parsed = TrustRulesListIpcParamsSchema.parse(params);
      return listTrustRules({
        origin: parsed.origin,
        tool: parsed.tool,
        includeAll: parsed.include_all,
        includeDeleted: parsed.include_deleted,
      });
    },
  },
];
