import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "bun:test";

import type { z } from "zod";

import { toToolInputSchema } from "../shared/zod-tool-schema.js";
import { subagentAbortInputSchema } from "../subagent/abort.js";
import { subagentMessageInputSchema } from "../subagent/message.js";
import { subagentReadInputSchema } from "../subagent/read.js";
import { subagentSpawnInputSchema } from "../subagent/spawn.js";
import { subagentStatusInputSchema } from "../subagent/status.js";
import { manageWorkflowsInputSchema } from "../workflows/manage-workflows.js";
import { runWorkflowInputSchema } from "../workflows/run-workflow.js";
import { expectNoSchemaDrift } from "./tool-schema-drift-harness.js";

/**
 * Drift guard between the subagent and workflows skills' hand-written
 * `TOOLS.json` `input_schema`s (the advertised contract) and the executors'
 * runtime Zod schemas. See `tool-schema-drift-harness.ts` for what is (and
 * deliberately is not) compared.
 */

function loadToolsJson(
  skill: string,
): Parameters<typeof expectNoSchemaDrift>[1] {
  return JSON.parse(
    readFileSync(
      join(import.meta.dir, `../../config/bundled-skills/${skill}/TOOLS.json`),
      "utf8",
    ),
  ) as Parameters<typeof expectNoSchemaDrift>[1];
}

const CASES: {
  skill: string;
  name: string;
  schema: z.ZodType;
  advertiseRequired?: string[];
  passthrough?: Record<string, string>;
}[] = [
  {
    skill: "subagent",
    name: "subagent_spawn",
    schema: subagentSpawnInputSchema,
    advertiseRequired: ["label", "objective"],
    passthrough: {
      fork: "deliberate `=== true` coercion owns malformed values",
      send_result_to_user:
        "deliberate `=== true` / `!== false` coercions own malformed values",
      role: "SubagentManager.spawn's 'Invalid subagent role' error (test-asserted) owns non-enum values",
    },
  },
  {
    skill: "subagent",
    name: "subagent_status",
    schema: subagentStatusInputSchema,
  },
  {
    skill: "subagent",
    name: "subagent_abort",
    schema: subagentAbortInputSchema,
  },
  {
    skill: "subagent",
    name: "subagent_message",
    schema: subagentMessageInputSchema,
    advertiseRequired: ["content"],
  },
  {
    skill: "subagent",
    name: "subagent_read",
    schema: subagentReadInputSchema,
    passthrough: {
      last_n:
        "typeof-guarded read ignores malformed values (including non-integer numbers the advertised type wouldn't admit)",
    },
  },
  {
    skill: "workflows",
    name: "run_workflow",
    schema: runWorkflowInputSchema,
    passthrough: {
      args: "workflow runtime accepts any JSON value as args",
      capabilities:
        "CapabilityManifestSchema is the single validation authority; executor.ts reads it pre-execution for the requireFreshApproval promotion",
    },
  },
  {
    skill: "workflows",
    name: "manage_workflows",
    schema: manageWorkflowsInputSchema,
    advertiseRequired: ["action"],
    passthrough: {
      action:
        "switch default owns the unknown-action error; executor.ts reads it pre-execution for the requireFreshApproval promotion",
    },
  },
];

describe("subagent + workflows TOOLS.json ↔ runtime Zod schema drift guard", () => {
  for (const c of CASES) {
    test(`${c.skill}:${c.name}`, () => {
      expectNoSchemaDrift(
        {
          name: c.name,
          derived: toToolInputSchema(c.schema, {
            advertiseRequired: c.advertiseRequired,
          }),
          passthrough: c.passthrough,
        },
        loadToolsJson(c.skill),
      );
    });
  }
});
