import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "bun:test";

import type { z } from "zod";

import { conversationGroupCreateInputSchema } from "../conversation-groups/group_create.js";
import { conversationMoveToGroupInputSchema } from "../conversation-groups/move_to_group.js";
import { toToolInputSchema } from "../shared/zod-tool-schema.js";
import { expectNoSchemaDrift } from "./tool-schema-drift-harness.js";

/**
 * Drift guard between the conversation-groups skill's hand-written
 * `TOOLS.json` `input_schema`s and the executors' runtime Zod schemas. See
 * `tool-schema-drift-harness.ts` for what is (and deliberately is not)
 * compared. `conversation_group_list` takes no input and has no runtime
 * schema, so it has no entry here.
 */

const toolsJson = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      "../../config/bundled-skills/conversation-groups/TOOLS.json",
    ),
    "utf8",
  ),
) as Parameters<typeof expectNoSchemaDrift>[1];

const CASES: {
  name: string;
  schema: z.ZodType;
  advertiseRequired?: string[];
}[] = [
  {
    name: "conversation_group_create",
    schema: conversationGroupCreateInputSchema,
    advertiseRequired: ["name"],
  },
  {
    name: "conversation_move_to_group",
    schema: conversationMoveToGroupInputSchema,
    advertiseRequired: ["group"],
  },
];

describe("conversation-groups TOOLS.json ↔ runtime Zod schema drift guard", () => {
  for (const c of CASES) {
    test(c.name, () => {
      expectNoSchemaDrift(
        {
          name: c.name,
          derived: toToolInputSchema(c.schema, {
            advertiseRequired: c.advertiseRequired,
          }),
        },
        toolsJson,
      );
    });
  }
});
