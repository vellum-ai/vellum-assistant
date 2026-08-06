import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "bun:test";

import type { z } from "zod";

import {
  commentListInputSchema,
  commentReplyInputSchema,
  commentResolveInputSchema,
} from "../document/document-comment-tool.js";
import {
  documentCreateInputSchema,
  documentDeleteInputSchema,
  documentFindInputSchema,
  documentListInputSchema,
  documentOpenInputSchema,
  documentReadInputSchema,
  documentReplaceTextInputSchema,
  documentUpdateInputSchema,
} from "../document/document-tool.js";
import { toToolInputSchema } from "../shared/zod-tool-schema.js";
import { expectNoSchemaDrift } from "./tool-schema-drift-harness.js";

/**
 * Drift guard between the document-editor skill's hand-written `TOOLS.json`
 * `input_schema`s (the advertised contract) and the executors' runtime Zod
 * schemas. See `tool-schema-drift-harness.ts` for what is (and deliberately
 * is not) compared.
 */

const TOOLS_JSON = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      "../../config/bundled-skills/document-editor/TOOLS.json",
    ),
    "utf8",
  ),
) as Parameters<typeof expectNoSchemaDrift>[1];

const CASES: {
  name: string;
  schema: z.ZodType;
  advertiseRequired?: string[];
  passthrough?: Record<string, string>;
}[] = [
  {
    name: "document_open",
    schema: documentOpenInputSchema,
    advertiseRequired: ["surface_id"],
  },
  { name: "document_create", schema: documentCreateInputSchema },
  {
    name: "document_update",
    schema: documentUpdateInputSchema,
    advertiseRequired: ["content"],
    passthrough: {
      mode: "bespoke check owns the error message and the { mode: null } tolerance that mirrors validateInputAgainstSchema",
    },
  },
  {
    name: "document_read",
    schema: documentReadInputSchema,
    advertiseRequired: ["surface_id"],
  },
  { name: "document_list", schema: documentListInputSchema },
  {
    name: "document_delete",
    schema: documentDeleteInputSchema,
    advertiseRequired: ["surface_id"],
  },
  {
    name: "document_find",
    schema: documentFindInputSchema,
    advertiseRequired: ["surface_id"],
  },
  {
    name: "document_replace_text",
    schema: documentReplaceTextInputSchema,
    advertiseRequired: ["surface_id", "replace"],
  },
  { name: "comment_list", schema: commentListInputSchema },
  { name: "comment_resolve", schema: commentResolveInputSchema },
  { name: "comment_reply", schema: commentReplyInputSchema },
];

describe("document-editor TOOLS.json ↔ runtime Zod schema drift guard", () => {
  for (const c of CASES) {
    test(c.name, () => {
      expectNoSchemaDrift(
        {
          name: c.name,
          derived: toToolInputSchema(c.schema, {
            advertiseRequired: c.advertiseRequired,
          }),
          passthrough: c.passthrough,
        },
        TOOLS_JSON,
      );
    });
  }
});
