import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "bun:test";

import type { z } from "zod";

import { acpAbortInputSchema } from "../acp/abort.js";
import { acpSpawnInputSchema } from "../acp/spawn.js";
import { acpStatusInputSchema } from "../acp/status.js";
import { acpSteerInputSchema } from "../acp/steer.js";
import { callEndInputSchema } from "../calls/call-end.js";
import { callStartInputSchema } from "../calls/call-start.js";
import { callStatusInputSchema } from "../calls/call-status.js";
import { followupCreateInputSchema } from "../followups/followup_create.js";
import { followupListInputSchema } from "../followups/followup_list.js";
import { followupResolveInputSchema } from "../followups/followup_resolve.js";
import { toToolInputSchema } from "../shared/zod-tool-schema.js";
import { expectNoSchemaDrift } from "./tool-schema-drift-harness.js";

/**
 * Drift guard between the followups / phone-calls / acp skills' hand-written
 * `TOOLS.json` `input_schema`s (the advertised contract) and the executors'
 * runtime Zod schemas. See `tool-schema-drift-harness.ts` for what is (and
 * deliberately is not) compared. `acp_list_agents` takes no input and has no
 * runtime schema, so it has no entry here.
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
    skill: "followups",
    name: "followup_create",
    schema: followupCreateInputSchema,
    advertiseRequired: ["channel", "conversation_id"],
    passthrough: {
      expected_response_hours:
        "bespoke positive-number check owns the error message for every malformed shape (per LUM-2856)",
    },
  },
  {
    skill: "followups",
    name: "followup_list",
    schema: followupListInputSchema,
    passthrough: {
      status:
        "bespoke VALID_STATUSES check owns the 'Invalid status' error (test-asserted)",
    },
  },
  {
    skill: "followups",
    name: "followup_resolve",
    schema: followupResolveInputSchema,
  },
  {
    skill: "phone-calls",
    name: "call_start",
    schema: callStartInputSchema,
    passthrough: {
      skip_disclosure: "deliberate `=== true` coercion owns malformed values",
    },
  },
  {
    skill: "phone-calls",
    name: "call_status",
    schema: callStatusInputSchema,
  },
  {
    skill: "phone-calls",
    name: "call_end",
    schema: callEndInputSchema,
    advertiseRequired: ["call_session_id"],
  },
  {
    skill: "acp",
    name: "acp_spawn",
    schema: acpSpawnInputSchema,
    advertiseRequired: ["task"],
  },
  { skill: "acp", name: "acp_status", schema: acpStatusInputSchema },
  {
    skill: "acp",
    name: "acp_abort",
    schema: acpAbortInputSchema,
    advertiseRequired: ["acp_session_id"],
  },
  {
    skill: "acp",
    name: "acp_steer",
    schema: acpSteerInputSchema,
    advertiseRequired: ["acp_session_id", "instruction"],
  },
];

describe("followups + phone-calls + acp TOOLS.json ↔ runtime Zod schema drift guard", () => {
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
