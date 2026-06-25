import { describe, expect, test } from "bun:test";

import {
  liveRowsSupersededByServer,
  serverHasAssistantProgress,
  serverSnapshotHasNewContent,
} from "@/domains/chat/utils/reconcile-detection";
import type { DisplayMessage } from "@/domains/chat/types/types";
import {
  textBody,
  thinkingBodyWithBlocks,
} from "@/domains/chat/utils/message-test-helpers";

function userRow(id: string, text: string): DisplayMessage {
  return { id, role: "user", ...textBody(text) } as DisplayMessage;
}
function assistantRow(id: string, text: string): DisplayMessage {
  return { id, role: "assistant", ...textBody(text) } as DisplayMessage;
}
function thinkingOnlyRow(id: string, thinking: string): DisplayMessage {
  return {
    id,
    role: "assistant",
    ...thinkingBodyWithBlocks(thinking),
  } as DisplayMessage;
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

// ---------------------------------------------------------------------------
// liveRowsSupersededByServer — the self-healing live-turn prune that recovers
// the "I said yo and it didn't respond" orphan: a thinking-only live row left
// behind by a mid-turn abort, shadowing the server's finished reply.
// ---------------------------------------------------------------------------

describe("liveRowsSupersededByServer", () => {
  test("drops a terminal-turn orphan the server has finished (the yo bug)", () => {
    const orphan = thinkingOnlyRow("a1", "let me think about yo");
    const superseded = liveRowsSupersededByServer(
      [orphan],
      [userRow("u1", "yo"), assistantRow("a1", "yo, what's up")],
      true,
    );
    expect(superseded).toEqual([orphan]);
  });

  test("keeps every live row while the turn is still streaming", () => {
    const orphan = thinkingOnlyRow("a1", "thinking");
    expect(
      liveRowsSupersededByServer(
        [orphan],
        [userRow("u1", "yo"), assistantRow("a1", "yo, what's up")],
        false,
      ),
    ).toEqual([]);
  });

  test("keeps a live row the server snapshot does not yet carry", () => {
    expect(
      liveRowsSupersededByServer(
        [assistantRow("a2", "streamed reply")],
        [userRow("u1", "yo"), assistantRow("a1", "older reply")],
        true,
      ),
    ).toEqual([]);
  });

  test("keeps a live row whose text is ahead of the lagging server copy", () => {
    // Server persistence briefly trails the live row — dropping it would flash
    // the transcript backward, so it must survive until the server catches up.
    expect(
      liveRowsSupersededByServer(
        [assistantRow("a1", "full streamed answer")],
        [assistantRow("a1", "full")],
        true,
      ),
    ).toEqual([]);
  });

  test("matches on the client nonce when the server adopted the id", () => {
    const optimistic = {
      id: "client-temp",
      clientMessageId: "nonce-1",
      role: "user",
      ...textBody("yo"),
    } as DisplayMessage;
    const serverEcho = {
      id: "server-1",
      clientMessageId: "nonce-1",
      role: "user",
      ...textBody("yo"),
    } as DisplayMessage;
    expect(
      liveRowsSupersededByServer([optimistic], [serverEcho], true),
    ).toEqual([optimistic]);
  });

  test("no-ops on an empty live turn", () => {
    expect(
      liveRowsSupersededByServer([], [assistantRow("a1", "reply")], true),
    ).toEqual([]);
  });
});
