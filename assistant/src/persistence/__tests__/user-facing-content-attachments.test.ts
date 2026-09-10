/**
 * A `vellum://` link the model puts in a `send_user_message` message must be
 * found by the attachment-directive scan, exactly as a link in ordinary
 * assistant text is: the projected text blocks are what a user reads, so they
 * are what `cleanAssistantContent` walks on a row marked private. Without the
 * projection the directive is invisible and channel delivery posts the label
 * with no file attached.
 */

import { describe, expect, test } from "bun:test";

import { cleanAssistantContent } from "../../daemon/assistant-attachments.js";
import type { ContentBlock } from "../../providers/types.js";
import { projectUserFacingContent } from "../user-facing-content.js";

const CONTENT = [
  { type: "text", text: "Wrote the report; sharing it now." },
  {
    type: "tool_use",
    id: "tu_1",
    name: "send_user_message",
    input: {
      message: "Here it is: [report.md](vellum://workspace/report.md)",
    },
  },
] as ContentBlock[];

describe("attachment directives in a delivered tool message", () => {
  test("the raw blocks carry no directive", () => {
    const { directives } = cleanAssistantContent(CONTENT);
    expect(directives).toHaveLength(0);
  });

  test("the projected blocks carry the directive", () => {
    const projected = projectUserFacingContent(CONTENT, { toolGated: true });
    const { directives } = cleanAssistantContent(projected);
    expect(directives).toHaveLength(1);
    expect(directives[0]?.path).toContain("report.md");
  });
});
