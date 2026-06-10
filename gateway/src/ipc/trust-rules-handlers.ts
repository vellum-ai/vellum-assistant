/**
 * IPC route definitions for gateway-owned trust rules.
 */

import { z } from "zod";

import { listTrustRules } from "../http/routes/trust-rules.js";
import type { IpcRoute } from "./server.js";

const TrustRulesListParamsSchema = z
  .object({
    origin: z.string().optional(),
    tool: z.string().optional(),
    include_all: z.boolean().optional(),
    include_deleted: z.boolean().optional(),
  })
  .strict()
  .default({});

export const trustRulesRoutes: IpcRoute[] = [
  {
    method: "trust_rules_list",
    schema: TrustRulesListParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const parsed = TrustRulesListParamsSchema.parse(params);
      return listTrustRules({
        origin: parsed.origin,
        tool: parsed.tool,
        includeAll: parsed.include_all,
        includeDeleted: parsed.include_deleted,
      });
    },
  },
];
