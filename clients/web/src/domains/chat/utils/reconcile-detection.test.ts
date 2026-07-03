import { describe, expect, test } from "bun:test";

import {
  serverHasAssistantProgress,
  serverSnapshotHasNewContent,
} from "@/domains/chat/utils/reconcile-detection";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { textBody } from "@/domains/chat/utils/message-test-helpers";

function userRow(id: string, text: string): DisplayMessage {
  return { id, role: "user", ...textBody(text) } as DisplayMessage;
}
function assistantRow(id: string, text: string): DisplayMessage {
  return { id, role: "assistant", ...textBody(text) } as DisplayMessage;
}

// ---------------------------------------------------------------------------
// serverSnapshotHasNewContent — the structural "is there anything new?" half.
// ---------------------------------------------------------------------------

describe("serverSnapshotHasNewContent", () => {
  test("true when the server has a row absent from the local view", () => {
    expect(
      serverSnapshotHasNewContent(
        [userRow("u1", "hi"), assistantRow("a1", "hello")],
        [userRow("u1", "hi")],
      ),
    ).toBe(true);
  });

  test("true when a matched row's text has grown on the server", () => {
    expect(
      serverSnapshotHasNewContent(
        [assistantRow("a1", "partial answer")],
        [assistantRow("a1", "par")],
      ),
    ).toBe(true);
  });

  test("false when the server matches the local view", () => {
    expect(
      serverSnapshotHasNewContent(
        [userRow("u1", "hi"), assistantRow("a1", "hello")],
        [userRow("u1", "hi"), assistantRow("a1", "hello")],
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// serverHasAssistantProgress — the assistant-output half of the rescue gate.
// ---------------------------------------------------------------------------

describe("serverHasAssistantProgress", () => {
  test("true when the server has an assistant reply the local turn lacks", () => {
    expect(
      serverHasAssistantProgress(
        [userRow("u1", "question")],
        [userRow("u1", "question"), assistantRow("a1", "answer")],
        true,
      ),
    ).toBe(true);
  });

  test("false when local already shows the server's assistant content", () => {
    // The no-false-rescue guard: an idle conversation where server and local
    // agree must not look like a missed terminal event.
    expect(
      serverHasAssistantProgress(
        [userRow("u1", "question"), assistantRow("a1", "answer")],
        [userRow("u1", "question"), assistantRow("a1", "answer")],
        false,
      ),
    ).toBe(false);
  });

  test("true when the server's assistant text is longer than the local row", () => {
    expect(
      serverHasAssistantProgress(
        [userRow("u1", "q"), assistantRow("a1", "par")],
        [userRow("u1", "q"), assistantRow("a1", "partial answer")],
        true,
      ),
    ).toBe(true);
  });
});
