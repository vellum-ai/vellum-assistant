/**
 * Verifies the retroactive credential transcript scrub engine: stored
 * credential values are removed from recent DB message rows (text blocks,
 * tool_use inputs, tool_result content, legacy plain-string rows) and from
 * resident in-memory conversation histories, with lexical reindex and
 * disk-view rebuild side effects — and the function never throws.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ── Shared mock plumbing (must precede module-under-test imports) ──────────
//
// `mock.module` is process-global in Bun and leaks into sibling files run in
// the same invocation, so every stub delegates to the real implementation
// unless this file's tests are active (`scrubMocksActive`, toggled in
// beforeAll/afterAll). The real exports are snapshotted into plain objects
// NOW, before the stubs register — a module namespace is a live view, so
// reading a real export after the stub installs would resolve to the stub.

let scrubMocksActive = false;

const realDbConnection = {
  ...(await import("../persistence/db-connection.js")),
};
const realConversationCrud = {
  ...(await import("../persistence/conversation-crud.js")),
};
const realDiskView = {
  ...(await import("../persistence/conversation-disk-view.js")),
};
const realMessageLexical = {
  ...(await import("../persistence/job-handlers/message-lexical.js")),
};
const realRegistry = {
  ...(await import("../daemon/conversation-registry.js")),
};
const realReadiness = {
  ...(await import("../daemon/daemon-readiness.js")),
};

interface FakeDbRow {
  id: string;
  conversationId: string;
  content: string;
}
const dbRows: FakeDbRow[] = [];

// The engine builds its WHERE clause with real drizzle expressions (ignored
// here) and consumes `.select().from().where().all()`.
const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({ all: () => dbRows.map((row) => ({ ...row })) }),
    }),
  }),
};

mock.module("../persistence/db-connection.js", () => ({
  ...realDbConnection,
  getDb: () => (scrubMocksActive ? fakeDb : realDbConnection.getDb()),
}));

const updateCalls: Array<{ messageId: string; content: string }> = [];
const updateThrowsFor = new Set<string>();
mock.module("../persistence/conversation-crud.js", () => ({
  ...realConversationCrud,
  updateMessageContent: (messageId: string, content: string) => {
    if (!scrubMocksActive) {
      return realConversationCrud.updateMessageContent(messageId, content);
    }
    if (updateThrowsFor.has(messageId)) {
      throw new Error("simulated write failure");
    }
    updateCalls.push({ messageId, content });
  },
}));

const rebuildCalls: string[] = [];
mock.module("../persistence/conversation-disk-view.js", () => ({
  ...realDiskView,
  rebuildConversationDiskViewFromDbState: (conversationId: string) => {
    if (!scrubMocksActive) {
      return realDiskView.rebuildConversationDiskViewFromDbState(
        conversationId,
      );
    }
    rebuildCalls.push(conversationId);
  },
}));

const lexicalCalls: string[] = [];
mock.module("../persistence/job-handlers/message-lexical.js", () => ({
  ...realMessageLexical,
  enqueueLexicalIndexForMessage: (messageId: string) => {
    if (!scrubMocksActive) {
      return realMessageLexical.enqueueLexicalIndexForMessage(messageId);
    }
    lexicalCalls.push(messageId);
  },
}));

interface FakeResidentMessage {
  role: string;
  content: Array<Record<string, unknown>>;
}
interface FakeResidentConversation {
  conversationId: string;
  messages: FakeResidentMessage[];
}
const residentConversations: FakeResidentConversation[] = [];
const residentSubagentConversations: FakeResidentConversation[] = [];
mock.module("../daemon/conversation-registry.js", () => ({
  ...realRegistry,
  allConversations: () =>
    scrubMocksActive
      ? residentConversations.values()
      : realRegistry.allConversations(),
  allSubagentConversations: () =>
    scrubMocksActive
      ? residentSubagentConversations.values()
      : realRegistry.allSubagentConversations(),
}));

mock.module("../daemon/daemon-readiness.js", () => ({
  ...realReadiness,
  getDbMigrationReadiness: () =>
    scrubMocksActive
      ? { ready: true, state: "ready" }
      : realReadiness.getDbMigrationReadiness(),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import {
  buildSearchTargets,
  scrubStoredCredentialFromTranscripts,
} from "../daemon/credential-transcript-scrub.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const VALUE = "test-credential-value-1234567890";
const MARKER = '<redacted type="Credential" />';

function textRow(id: string, conversationId: string, text: string): FakeDbRow {
  return {
    id,
    conversationId,
    content: JSON.stringify([{ type: "text", text }]),
  };
}

function updatedContentFor(messageId: string): string {
  const call = updateCalls.find((c) => c.messageId === messageId);
  if (!call) {
    throw new Error(`No updateMessageContent call for ${messageId}`);
  }
  return call.content;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("buildSearchTargets", () => {
  test("a metachar-free value yields exactly one target", () => {
    expect(buildSearchTargets("plain-value-1234567890")).toEqual([
      "plain-value-1234567890",
    ]);
  });

  test("a value with JSON metacharacters includes the twice-escaped column form", () => {
    const value = 'pa"ss\\word_1234';
    const esc1 = JSON.stringify(value).slice(1, -1);
    const esc2 = JSON.stringify(esc1).slice(1, -1);

    // The LIKE prefilter must select rows whose stored column bytes hold the
    // twice-escaped form (a block string embedding JSON that contains the
    // value); longest-first ordering keeps escaped forms from being
    // half-eaten by their shorter twins during replacement.
    expect(buildSearchTargets(value)).toEqual([esc2, esc1, value]);
  });
});

beforeAll(() => {
  scrubMocksActive = true;
});
afterAll(() => {
  scrubMocksActive = false;
});

describe("scrubStoredCredentialFromTranscripts", () => {
  beforeEach(() => {
    dbRows.length = 0;
    updateCalls.length = 0;
    updateThrowsFor.clear();
    rebuildCalls.length = 0;
    lexicalCalls.length = 0;
    residentConversations.length = 0;
    residentSubagentConversations.length = 0;
  });

  test("scrubs a user text message and stamps _redactionVersion", async () => {
    dbRows.push(textRow("msg-1", "conv-1", `here is my key: ${VALUE}`));

    const result = await scrubStoredCredentialFromTranscripts(VALUE);

    expect(result.dbMessagesScrubbed).toBe(1);
    const blocks = JSON.parse(updatedContentFor("msg-1")) as Array<
      Record<string, unknown>
    >;
    expect(blocks[0].text).toBe(`here is my key: ${MARKER}`);
    expect(blocks[0]._redactionVersion).toBe(2);
    expect(lexicalCalls).toEqual(["msg-1"]);
    expect(rebuildCalls).toEqual(["conv-1"]);
  });

  test("scrubs the JSON-escaped form inside a tool_use command input", async () => {
    const quotedValue = 'cred-"quoted"-value-1234';
    const escapedForm = JSON.stringify(quotedValue).slice(1, -1);
    dbRows.push({
      id: "msg-2",
      conversationId: "conv-2",
      content: JSON.stringify([
        {
          type: "tool_use",
          id: "tu-1",
          name: "bash",
          // The string leaf itself embeds JSON-encoded text, so it carries
          // the escaped form, not the raw value.
          input: { command: `curl -d '{"key":"${escapedForm}"}'` },
        },
      ]),
    });

    const result = await scrubStoredCredentialFromTranscripts(quotedValue);

    expect(result.dbMessagesScrubbed).toBe(1);
    const content = updatedContentFor("msg-2");
    expect(content).not.toContain("quoted");
    const blocks = JSON.parse(content) as Array<{
      input: { command: string };
    }>;
    expect(blocks[0].input.command).toBe(`curl -d '{"key":"${MARKER}"}'`);
  });

  test("scrubs tool_result string content", async () => {
    dbRows.push({
      id: "msg-3",
      conversationId: "conv-3",
      content: JSON.stringify([
        { type: "tool_result", tool_use_id: "tu-1", content: `out: ${VALUE}` },
      ]),
    });

    const result = await scrubStoredCredentialFromTranscripts(VALUE);

    expect(result.dbMessagesScrubbed).toBe(1);
    const blocks = JSON.parse(updatedContentFor("msg-3")) as Array<{
      content: string;
    }>;
    expect(blocks[0].content).toBe(`out: ${MARKER}`);
  });

  test("re-serializes JSON-string content rows so they stay valid JSON", async () => {
    // `messages.content` can be a JSON-encoded bare string (the shape
    // `resolveMessageContentBlocks` unwraps to one text block). The marker
    // contains quotes, so a byte replace on the serialized form would
    // corrupt the row — the scrub must replace within the parsed value and
    // re-encode.
    dbRows.push({
      id: "msg-json-string",
      conversationId: "conv-js",
      content: JSON.stringify(`pasted: ${VALUE}`),
    });

    const result = await scrubStoredCredentialFromTranscripts(VALUE);

    expect(result.dbMessagesScrubbed).toBe(1);
    const updated = updatedContentFor("msg-json-string");
    const parsed: unknown = JSON.parse(updated);
    expect(parsed).toBe(`pasted: ${MARKER}`);
  });

  test("neutralizes forged sentinels when stamping an unmarked text block", async () => {
    // A pre-feature block never had sentinel-shaped strings neutralized at
    // write, and `renderHistoryContent` trusts `_redactionVersion`-stamped
    // blocks verbatim — so stamping without neutralizing would promote a
    // forged sentinel into a trusted, chip-renderable one.
    const forged = "〔redacted:Credential:vercel:api_token〕";
    dbRows.push(
      textRow("msg-forged", "conv-forged", `${forged} and key ${VALUE}`),
    );

    const result = await scrubStoredCredentialFromTranscripts(VALUE);

    expect(result.dbMessagesScrubbed).toBe(1);
    const blocks = JSON.parse(updatedContentFor("msg-forged")) as Array<
      Record<string, unknown>
    >;
    // Word joiner (U+2060) after the opening bracket defuses the forged
    // sentinel; the credential is scrubbed and the stamp applied.
    expect(blocks[0].text).toBe(
      `\u3014\u2060redacted:Credential:vercel:api_token\u3015 and key ${MARKER}`,
    );
    expect(blocks[0]._redactionVersion).toBe(2);
  });

  test("preserves redactor-authored sentinels in an already-stamped block", async () => {
    // A block the persist path stamped already had forgeries neutralized at
    // write — its surviving sentinels are redactor-authored and must not be
    // defused when the scrub touches the block.
    const genuine = "〔redacted:Credential:vercel:api_token〕";
    dbRows.push({
      id: "msg-stamped",
      conversationId: "conv-stamped",
      content: JSON.stringify([
        {
          type: "text",
          text: `${genuine} then ${VALUE}`,
          _redactionVersion: 2,
        },
      ]),
    });

    const result = await scrubStoredCredentialFromTranscripts(VALUE);

    expect(result.dbMessagesScrubbed).toBe(1);
    const blocks = JSON.parse(updatedContentFor("msg-stamped")) as Array<
      Record<string, unknown>
    >;
    expect(blocks[0].text).toBe(`${genuine} then ${MARKER}`);
    expect(blocks[0]._redactionVersion).toBe(2);
  });

  test("scrubs unsigned thinking blocks", async () => {
    dbRows.push({
      id: "msg-think",
      conversationId: "conv-1",
      content: JSON.stringify([
        { type: "thinking", thinking: `planning with ${VALUE}`, signature: "" },
      ]),
    });

    const result = await scrubStoredCredentialFromTranscripts(VALUE);

    expect(result.dbMessagesScrubbed).toBe(1);
    const blocks = JSON.parse(updatedContentFor("msg-think")) as Array<
      Record<string, unknown>
    >;
    expect(blocks[0].thinking).toBe(`planning with ${MARKER}`);
  });

  test("leaves provider-signed thinking blocks untouched", async () => {
    // The signature covers the text; a rewritten signed block would be
    // rejected on history replay.
    dbRows.push({
      id: "msg-signed",
      conversationId: "conv-1",
      content: JSON.stringify([
        {
          type: "thinking",
          thinking: `planning with ${VALUE}`,
          signature: "provider-sig",
        },
      ]),
    });

    const result = await scrubStoredCredentialFromTranscripts(VALUE);

    expect(result.dbMessagesScrubbed).toBe(0);
    expect(updateCalls).toHaveLength(0);
  });

  test("scrubs legacy plain-string content rows with a plain replace", async () => {
    dbRows.push({
      id: "msg-legacy",
      conversationId: "conv-legacy",
      content: `plain history line with ${VALUE} in it`,
    });

    const result = await scrubStoredCredentialFromTranscripts(VALUE);

    expect(result.dbMessagesScrubbed).toBe(1);
    expect(updatedContentFor("msg-legacy")).toBe(
      `plain history line with ${MARKER} in it`,
    );
  });

  test("one call scrubs text, tool_use input, and tool_result across DB and resident memory", async () => {
    dbRows.push(
      textRow("msg-a", "conv-x", `pasted: ${VALUE}`),
      {
        id: "msg-b",
        conversationId: "conv-x",
        content: JSON.stringify([
          {
            type: "tool_use",
            id: "tu-2",
            name: "bash",
            input: { command: `assistant credentials set --value ${VALUE}` },
          },
        ]),
      },
      {
        id: "msg-c",
        conversationId: "conv-y",
        content: JSON.stringify([
          { type: "tool_result", tool_use_id: "tu-2", content: `ok ${VALUE}` },
        ]),
      },
    );
    residentConversations.push({
      conversationId: "conv-x",
      messages: [
        { role: "user", content: [{ type: "text", text: `pasted: ${VALUE}` }] },
      ],
    });

    const result = await scrubStoredCredentialFromTranscripts(VALUE);

    expect(result.dbMessagesScrubbed).toBe(3);
    expect(result.residentMessagesScrubbed).toBe(1);
    // Inside serialized block JSON the marker's quotes are JSON-escaped.
    const escapedMarker = JSON.stringify(MARKER).slice(1, -1);
    for (const id of ["msg-a", "msg-b", "msg-c"]) {
      expect(updatedContentFor(id)).not.toContain(VALUE);
      expect(updatedContentFor(id)).toContain(escapedMarker);
    }
    expect(lexicalCalls.sort()).toEqual(["msg-a", "msg-b", "msg-c"]);
    // One disk-view rebuild per touched conversation.
    expect(rebuildCalls.sort()).toEqual(["conv-x", "conv-y"]);
  });

  test("scrubs resident in-memory conversation messages in place, including subagents", async () => {
    const topLevel: FakeResidentConversation = {
      conversationId: "conv-live",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: `my key is ${VALUE}` }],
        },
      ],
    };
    const subagent: FakeResidentConversation = {
      conversationId: "conv-sub",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu-3",
              name: "bash",
              input: { command: `echo ${VALUE}` },
            },
          ],
        },
      ],
    };
    residentConversations.push(topLevel);
    residentSubagentConversations.push(subagent);

    const result = await scrubStoredCredentialFromTranscripts(VALUE);

    expect(result.residentMessagesScrubbed).toBe(2);
    expect(topLevel.messages[0].content[0].text).toBe(`my key is ${MARKER}`);
    expect(topLevel.messages[0].content[0]._redactionVersion).toBe(2);
    const input = subagent.messages[0].content[0].input as {
      command: string;
    };
    expect(input.command).toBe(`echo ${MARKER}`);
    // In-memory sweep has no persistence side effects.
    expect(updateCalls).toEqual([]);
  });

  test("values shorter than 8 chars are a no-op", async () => {
    const short = "short12"; // 7 chars
    dbRows.push(textRow("msg-4", "conv-4", `key: ${short}`));
    residentConversations.push({
      conversationId: "conv-4",
      messages: [
        { role: "user", content: [{ type: "text", text: `key: ${short}` }] },
      ],
    });

    const result = await scrubStoredCredentialFromTranscripts(short);

    expect(result).toEqual({
      dbMessagesScrubbed: 0,
      residentMessagesScrubbed: 0,
    });
    expect(updateCalls).toEqual([]);
    expect(lexicalCalls).toEqual([]);
    expect(rebuildCalls).toEqual([]);
  });

  test("value absent from the transcript produces zero writes", async () => {
    dbRows.push(textRow("msg-5", "conv-5", "nothing sensitive here"));
    residentConversations.push({
      conversationId: "conv-5",
      messages: [
        { role: "user", content: [{ type: "text", text: "still nothing" }] },
      ],
    });

    const result = await scrubStoredCredentialFromTranscripts(VALUE);

    expect(result).toEqual({
      dbMessagesScrubbed: 0,
      residentMessagesScrubbed: 0,
    });
    expect(updateCalls).toEqual([]);
    expect(lexicalCalls).toEqual([]);
    expect(rebuildCalls).toEqual([]);
  });

  test("a message not containing the value is never rewritten", async () => {
    dbRows.push(
      textRow("msg-6", "conv-6", `secret: ${VALUE}`),
      textRow("msg-7", "conv-6", "unrelated message"),
    );

    const result = await scrubStoredCredentialFromTranscripts(VALUE);

    expect(result.dbMessagesScrubbed).toBe(1);
    expect(updateCalls.map((c) => c.messageId)).toEqual(["msg-6"]);
    expect(lexicalCalls).toEqual(["msg-6"]);
  });

  test("resolves with partial counts when updateMessageContent throws", async () => {
    dbRows.push(
      textRow("msg-8", "conv-8", `first: ${VALUE}`),
      textRow("msg-9", "conv-9", `second: ${VALUE}`),
    );
    updateThrowsFor.add("msg-8");

    const result = await scrubStoredCredentialFromTranscripts(VALUE);

    expect(result.dbMessagesScrubbed).toBe(1);
    expect(updateCalls.map((c) => c.messageId)).toEqual(["msg-9"]);
    // Side effects only fire for rows that were actually rewritten.
    expect(lexicalCalls).toEqual(["msg-9"]);
    expect(rebuildCalls).toEqual(["conv-9"]);
  });
});
