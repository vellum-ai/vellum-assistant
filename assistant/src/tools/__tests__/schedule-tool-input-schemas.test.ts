import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "bun:test";

import type { z } from "zod";

import { scheduleCreateInputSchema } from "../schedule/create.js";
import { scheduleDeleteInputSchema } from "../schedule/delete.js";
import { scheduleListInputSchema } from "../schedule/list.js";
import { scheduleUpdateInputSchema } from "../schedule/update.js";
import { toToolInputSchema } from "../shared/zod-tool-schema.js";
import { expectNoSchemaDrift } from "./tool-schema-drift-harness.js";

/**
 * Drift guard between the schedule skill's hand-written `TOOLS.json`
 * `input_schema`s (the advertised contract) and the executors' runtime Zod
 * schemas. See `tool-schema-drift-harness.ts` for what is (and deliberately
 * is not) compared.
 */

const TOOLS_JSON = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../config/bundled-skills/schedule/TOOLS.json"),
    "utf8",
  ),
) as Parameters<typeof expectNoSchemaDrift>[1];

const CASES: {
  name: string;
  schema: z.ZodType;
  advertiseRequired?: string[];
  passthrough?: Record<string, string>;
  nullableAtRuntime?: string[];
}[] = [
  {
    name: "schedule_create",
    schema: scheduleCreateInputSchema,
    advertiseRequired: ["name", "description"],
    passthrough: {
      mode: "bespoke VALID_MODES check owns the error semantics",
      routing_intent: "bespoke VALID_ROUTING_INTENTS check owns the error",
      capabilities:
        "CapabilityManifestSchema is the single validation authority; must reach the executor (and the requireFreshApproval promotion) unaltered",
      workflow_args: "workflow runtime accepts any JSON value as args",
    },
  },
  {
    name: "schedule_update",
    schema: scheduleUpdateInputSchema,
    advertiseRequired: ["job_id"],
    passthrough: {
      mode: "bespoke VALID_MODES check owns the error semantics",
      routing_intent: "bespoke VALID_ROUTING_INTENTS check owns the error",
      workflow_name: "typeof-guarded null fallback (non-string clears)",
      workflow_args: "workflow runtime accepts any JSON value as args",
    },
    nullableAtRuntime: ["timezone", "script", "routing_hints"],
  },
  { name: "schedule_list", schema: scheduleListInputSchema },
  {
    name: "schedule_delete",
    schema: scheduleDeleteInputSchema,
    advertiseRequired: ["job_id"],
  },
];

describe("schedule TOOLS.json ↔ runtime Zod schema drift guard", () => {
  for (const c of CASES) {
    test(c.name, () => {
      expectNoSchemaDrift(
        {
          name: c.name,
          derived: toToolInputSchema(c.schema, {
            advertiseRequired: c.advertiseRequired,
          }),
          passthrough: c.passthrough,
          nullableAtRuntime: c.nullableAtRuntime,
        },
        TOOLS_JSON,
      );
    });
  }
});
