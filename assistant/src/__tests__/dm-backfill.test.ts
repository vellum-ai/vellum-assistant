/**
 * PR 23 — verifies that the daemon lazily backfills DM history the first
 * time a Slack DM lands in a "cold" conversation (one with fewer than the
 * warm-storage threshold of stored slackMeta messages).
 *
 * Behaviour under test (see `inbound-message-handler.ts`):
 *  - On a fresh DM, `backfillDm` is invoked exactly once and every returned
 *    message is persisted as a `messages` row with a `slackMeta` envelope.
 *  - Once warm storage exceeds the threshold, subsequent inbound DMs do
 *    not re-trigger backfill.
 *  - When `backfillDm` throws, the turn proceeds without a crash and
 *    nothing extra is persisted.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks (must precede module imports under test)
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
}));

mock.module("../tools/credentials/metadata-store.js", () => ({
  getCredentialMetadata: () => undefined,
  upsertCredentialMetadata: () => {},
  deleteCredentialMetadata: () => {},
  listCredentialMetadata: () => [],
}));

mock.module("../runtime/gateway-client.js", () => ({
  deliverChannelReply: async () => {},
}));

mock.module("../messaging/providers/slack/adapter.js", () => ({
  withSlackBotToken: async (
    _account: string | undefined,
    fn: (token: string) => Promise<unknown>,
  ) => fn("test-slack-token"),
  resolveSlackBotUserId: async (
    _account: string | undefined,
    botId: string,
  ) => {
    if (botId === "B_ASSISTANT") return "U_BOT";
    return null;
  },
}));

import type { Message } from "../messaging/provider-types.js";

// `backfillDm` is the only piece of the slack provider surface this test
// needs to control. Mocking it directly keeps the test focused on the
// cold-start logic in the handler and avoids pulling in adapter wiring.
type BackfillDmFn = (
  channelId: string,
  opts?: { limit?: number; before?: string },
) => Promise<Message[]>;

const backfillDmMock = mock<BackfillDmFn>(async () => []);
const backfillThreadMock = mock(async () => [] as Message[]);

mock.module("../messaging/providers/slack/backfill.js", () => ({
  backfillDm: (channelId: string, opts?: { limit?: number; before?: string }) =>
    backfillDmMock(channelId, opts),
  backfillThread: () => backfillThreadMock(),
}));

import {
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../config/loader.js";
import { upsertContactChannel } from "../contacts/contacts-write.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { messages } from "../memory/schema/conversations.js";
import {
  readSlackMetadata,
  type SlackMessageMetadata,
} from "../messaging/providers/slack/message-metadata.js";
import { handleChannelInbound } from "./helpers/channel-test-adapter.js";

initializeDb();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_BEARER_TOKEN = "test-token";
const SLACK_DM_CHANNEL_ID = "D0BACKFILL";
const SLACK_DM_USER_ID = "U_DM_USER";
const SLACK_DM_DISPLAY_NAME = "DM Sender";

function resetState(): void {
  const db = getDb();
  db.run("DELETE FROM messages");
  db.run("DELETE FROM channel_inbound_events");
  db.run("DELETE FROM conversations");
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
  db.run("DELETE FROM external_conversation_bindings");
  setConfiguredSlackBotUserId("U_BOT");
}

function setConfiguredSlackBotUserId(botUserId: string): void {
  const raw = loadRawConfig();
  setNestedValue(raw, "slack.botUserId", botUserId);
  saveRawConfig(raw);
}

function seedActiveMember(): void {
  upsertContactChannel({
    sourceChannel: "slack",
    externalUserId: SLACK_DM_USER_ID,
    externalChatId: SLACK_DM_CHANNEL_ID,
    status: "active",
    policy: "allow",
    displayName: SLACK_DM_DISPLAY_NAME,
  });
}

function seedSlackGuardian(): void {
  upsertContactChannel({
    sourceChannel: "slack",
    externalUserId: SLACK_DM_USER_ID,
    externalChatId: SLACK_DM_CHANNEL_ID,
    status: "active",
    policy: "allow",
    displayName: SLACK_DM_DISPLAY_NAME,
    role: "guardian",
  });
}

let msgCounter = 0;

function buildDmRequest(
  text: string,
  overrides: Record<string, unknown> = {},
): Request {
  msgCounter++;
  const ts = `1700000000.${String(100000 + msgCounter).padStart(6, "0")}`;
  const body: Record<string, unknown> = {
    sourceChannel: "slack",
    interface: "slack",
    conversationExternalId: SLACK_DM_CHANNEL_ID,
    externalMessageId: `${SLACK_DM_CHANNEL_ID}:${ts}`,
    content: text,
    actorExternalId: SLACK_DM_USER_ID,
    actorDisplayName: SLACK_DM_DISPLAY_NAME,
    actorUsername: "dm_user",
    replyCallbackUrl: "http://localhost:7830/deliver/slack",
    sourceMetadata: {
      messageId: ts,
      // Critical — the cold-start trigger requires `chatType: "im"`.
      chatType: "im",
    },
    ...overrides,
  };
  return new Request("http://localhost:8080/channels/inbound", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gateway-Origin": TEST_BEARER_TOKEN,
    },
    body: JSON.stringify(body),
  });
}

function readPersistedSlackRows(): Array<{
  role: string;
  content: string;
  rawContent: string;
  slackMeta: SlackMessageMetadata | null;
  provenanceTrustClass: string | undefined;
  provenanceSourceChannel: string | undefined;
  provenanceGuardianExternalUserId: string | undefined;
  provenanceRequesterIdentifier: string | undefined;
}> {
  const db = getDb();
  return db
    .select({
      role: messages.role,
      content: messages.content,
      metadata: messages.metadata,
    })
    .from(messages)
    .all()
    .map((row) => {
      let envelope: Record<string, unknown> = {};
      if (row.metadata) {
        try {
          const parsed = JSON.parse(row.metadata) as unknown;
          if (
            parsed !== null &&
            typeof parsed === "object" &&
            !Array.isArray(parsed)
          ) {
            envelope = parsed as Record<string, unknown>;
          }
        } catch {
          envelope = {};
        }
      }
      const slackMeta =
        typeof envelope.slackMeta === "string"
          ? readSlackMetadata(envelope.slackMeta)
          : null;
      return {
        role: row.role,
        content: unwrapExternalContent(row.content),
        rawContent: row.content,
        slackMeta,
        provenanceTrustClass:
          typeof envelope.provenanceTrustClass === "string"
            ? envelope.provenanceTrustClass
            : undefined,
        provenanceSourceChannel:
          typeof envelope.provenanceSourceChannel === "string"
            ? envelope.provenanceSourceChannel
            : undefined,
        provenanceGuardianExternalUserId:
          typeof envelope.provenanceGuardianExternalUserId === "string"
            ? envelope.provenanceGuardianExternalUserId
            : undefined,
        provenanceRequesterIdentifier:
          typeof envelope.provenanceRequesterIdentifier === "string"
            ? envelope.provenanceRequesterIdentifier
            : undefined,
      };
    });
}

const EXTERNAL_CONTENT_WRAPPER =
  /^<external_content[^>]*>\n([\s\S]*?)\n<\/external_content>$/;

function unwrapExternalContent(content: string): string {
  const match = content.match(EXTERNAL_CONTENT_WRAPPER);
  return match ? match[1] : content;
}

function makeBackfilledMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "1700000000.090000",
    conversationId: SLACK_DM_CHANNEL_ID,
    sender: { id: SLACK_DM_USER_ID, name: "Backfilled Sender" },
    text: "older message",
    timestamp: 1700000000_000,
    platform: "slack",
    ...overrides,
  };
}

function noopProcessMessage(): Promise<{ messageId: string }> {
  // The agent loop is fire-and-forget in production, so the handler never
  // awaits a result. Returning a sentinel is enough to satisfy the type.
  return Promise.resolve({ messageId: "agent-stub" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PR 23 — Slack DM cold-start backfill", () => {
  beforeEach(() => {
    resetState();
    seedActiveMember();
    msgCounter = 0;
    backfillDmMock.mockReset();
    backfillDmMock.mockImplementation(async () => []);
    backfillThreadMock.mockReset();
  });

  test("first DM in cold conversation triggers backfill exactly once and persists history", async () => {
    const olderMessages: Message[] = [
      makeBackfilledMessage({
        id: "1700000000.000001",
        text: "older A",
        sender: { id: SLACK_DM_USER_ID, name: "Alice" },
      }),
      makeBackfilledMessage({
        id: "1700000000.000002",
        text: "older B",
        sender: { id: SLACK_DM_USER_ID, name: "Alice" },
      }),
      makeBackfilledMessage({
        id: "1700000000.000003",
        text: "older C",
        sender: { id: SLACK_DM_USER_ID, name: "Alice" },
      }),
    ];
    backfillDmMock.mockImplementation(async () => olderMessages);

    const req = buildDmRequest("live new DM");
    const resp = await handleChannelInbound(
      req,
      noopProcessMessage,
      TEST_BEARER_TOKEN,
    );
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.accepted).toBe(true);
    expect(backfillDmMock).toHaveBeenCalledTimes(1);
    const [channelArg, optsArg] = backfillDmMock.mock.calls[0];
    expect(channelArg).toBe(SLACK_DM_CHANNEL_ID);
    // The webhook message's own ts must be passed as `before` so Slack's
    // history window excludes it — otherwise backfill would re-insert the
    // message that the live inbound path is already persisting.
    expect(optsArg?.limit).toBe(50);
    expect(typeof optsArg?.before).toBe("string");
    expect(optsArg?.before).toMatch(/^1700000000\.10000/);

    // All three backfilled rows are persisted with a slackMeta envelope.
    // The live new DM's row is enqueued on the agent loop's persistence path
    // (which is mocked out here via `noopProcessMessage`), so the rows we
    // see in storage are exactly the backfilled ones.
    const rows = readPersistedSlackRows();
    expect(rows.length).toBe(3);

    const persistedTs = rows.map((r) => {
      const meta = r.slackMeta;
      expect(meta).not.toBeNull();
      expect(meta!.source).toBe("slack");
      expect(meta!.eventKind).toBe("message");
      expect(meta!.channelId).toBe(SLACK_DM_CHANNEL_ID);
      expect(meta!.actorExternalUserId).toBe(SLACK_DM_USER_ID);
      expect(r.provenanceTrustClass).toBe("unknown");
      expect(r.provenanceSourceChannel).toBe("slack");
      expect(r.provenanceRequesterIdentifier).toBe(SLACK_DM_USER_ID);
      return meta!.channelTs;
    });
    expect(new Set(persistedTs)).toEqual(
      new Set(["1700000000.000001", "1700000000.000002", "1700000000.000003"]),
    );

    // Backfilled rows preserve their original text content so the renderer
    // has something to display.
    const texts = rows.map((r) => r.content).sort();
    expect(texts).toEqual(["older A", "older B", "older C"]);
  });

  test("guardian DM backfill persists guardian text without external_content wrapping", async () => {
    resetState();
    seedSlackGuardian();

    backfillDmMock.mockImplementation(async () => [
      makeBackfilledMessage({
        id: "1700000000.000001",
        text: "trusted older context",
        sender: { id: SLACK_DM_USER_ID, name: "Guardian Sender" },
      }),
    ]);

    await handleChannelInbound(
      buildDmRequest("live guardian DM"),
      noopProcessMessage,
      TEST_BEARER_TOKEN,
    );

    const [row] = readPersistedSlackRows();
    expect(row).toBeDefined();
    expect(row.role).toBe("user");
    expect(row.rawContent).toBe("trusted older context");
    expect(row.rawContent).not.toContain("<external_content");
    expect(row.slackMeta?.actorExternalUserId).toBe(SLACK_DM_USER_ID);
    expect(row.provenanceTrustClass).toBe("guardian");
    expect(row.provenanceSourceChannel).toBe("slack");
    expect(row.provenanceGuardianExternalUserId).toBe(SLACK_DM_USER_ID);
    expect(row.provenanceRequesterIdentifier).toBe(SLACK_DM_USER_ID);
  });

  test("warm storage prevents re-trigger on subsequent DMs", async () => {
    backfillDmMock.mockImplementation(async () => [
      makeBackfilledMessage({ id: "1700000000.000001", text: "older A" }),
      makeBackfilledMessage({ id: "1700000000.000002", text: "older B" }),
      makeBackfilledMessage({ id: "1700000000.000003", text: "older C" }),
    ]);

    // First inbound: cold path, fires backfill.
    await handleChannelInbound(
      buildDmRequest("first live DM"),
      noopProcessMessage,
      TEST_BEARER_TOKEN,
    );
    expect(backfillDmMock).toHaveBeenCalledTimes(1);
    const rowsAfterFirst = readPersistedSlackRows();
    expect(rowsAfterFirst.length).toBe(3);

    // Second inbound: storage now has three slackMeta-tagged rows from the
    // backfill, which meets the warm threshold. Backfill MUST NOT be
    // re-invoked.
    const resp2 = await handleChannelInbound(
      buildDmRequest("second live DM"),
      noopProcessMessage,
      TEST_BEARER_TOKEN,
    );
    expect(resp2.status).toBe(200);
    expect(backfillDmMock).toHaveBeenCalledTimes(1);
    expect(readPersistedSlackRows().length).toBe(3);
  });

  test("backfill failure is non-fatal: turn proceeds without crash", async () => {
    backfillDmMock.mockImplementation(async () => {
      throw new Error("Slack API error: rate_limited");
    });

    const resp = await handleChannelInbound(
      buildDmRequest("live DM despite backfill failure"),
      noopProcessMessage,
      TEST_BEARER_TOKEN,
    );
    const json = (await resp.json()) as Record<string, unknown>;

    expect(resp.status).toBe(200);
    expect(json.accepted).toBe(true);
    expect(json.duplicate).toBe(false);
    expect(backfillDmMock).toHaveBeenCalledTimes(1);

    // No backfilled rows persisted because the call threw.
    const rows = readPersistedSlackRows();
    expect(rows.length).toBe(0);
  });

  test("non-DM Slack inbound does not trigger backfill", async () => {
    // chatType=channel must skip the cold-start branch entirely. This guards
    // against the trigger accidentally widening to channel messages.
    const req = buildDmRequest("channel message", {
      sourceMetadata: {
        messageId: "1700000000.999999",
        chatType: "channel",
      },
    });
    await handleChannelInbound(req, noopProcessMessage, TEST_BEARER_TOKEN);
    expect(backfillDmMock).toHaveBeenCalledTimes(0);
  });

  test("concurrent cold DMs share a single backfill (no double-write)", async () => {
    // Two near-simultaneous DMs into the same cold conversation must not
    // each trigger their own backfill — the in-flight lock dedupes them so
    // Slack history is fetched once and rows are written once.
    let resolveBackfill: ((messages: Message[]) => void) | null = null;
    backfillDmMock.mockImplementation(
      () =>
        new Promise<Message[]>((resolve) => {
          resolveBackfill = resolve;
        }),
    );

    const first = handleChannelInbound(
      buildDmRequest("first concurrent DM"),
      noopProcessMessage,
      TEST_BEARER_TOKEN,
    );
    const second = handleChannelInbound(
      buildDmRequest("second concurrent DM"),
      noopProcessMessage,
      TEST_BEARER_TOKEN,
    );

    // Wait for both handlers to register their await on the in-flight
    // promise before resolving the underlying backfill fetch.
    await new Promise((r) => setTimeout(r, 10));
    expect(resolveBackfill).not.toBeNull();
    resolveBackfill!([
      makeBackfilledMessage({ id: "1700000000.000001", text: "older A" }),
      makeBackfilledMessage({ id: "1700000000.000002", text: "older B" }),
    ]);

    await Promise.all([first, second]);

    expect(backfillDmMock).toHaveBeenCalledTimes(1);
    const rows = readPersistedSlackRows();
    expect(rows.length).toBe(2);
    const texts = rows.map((r) => r.content).sort();
    expect(texts).toEqual(["older A", "older B"]);
  });

  test("bot-authored backfilled messages are persisted raw as user history", async () => {
    // Backfilled Slack history is third-party channel replay. Even bot rows
    // must not become `assistant` messages; that role is reserved for outputs
    // produced by the local assistant loop.
    backfillDmMock.mockImplementation(async () => [
      makeBackfilledMessage({
        id: "1700000000.000001",
        text: "user reply",
        sender: { id: SLACK_DM_USER_ID, name: "Alice" },
      }),
      makeBackfilledMessage({
        id: "1700000000.000002",
        text: "assistant reply",
        sender: { id: "B_BOT", name: "assistant-bot" },
        metadata: { isBot: true },
      }),
    ]);

    await handleChannelInbound(
      buildDmRequest("live new DM"),
      noopProcessMessage,
      TEST_BEARER_TOKEN,
    );

    const rows = readPersistedSlackRows();
    expect(rows.length).toBe(2);
    const byText = new Map(rows.map((r) => [r.content, r.role]));
    expect(byText.get("user reply")).toBe("user");
    expect(byText.get("assistant reply")).toBe("user");
    const botRow = rows.find((r) => r.content === "assistant reply");
    expect(botRow?.rawContent).toBe("assistant reply");
    expect(botRow?.rawContent).not.toContain("<external_content");
    expect(botRow?.slackMeta?.actorExternalUserId).toBe("B_BOT");
    expect(botRow?.provenanceTrustClass).toBe("unknown");
    expect(botRow?.provenanceSourceChannel).toBe("slack");
    expect(botRow?.provenanceRequesterIdentifier).toBe("B_BOT");
  });

  test("skips Slack assistant new-thread placeholder during DM backfill", async () => {
    backfillDmMock.mockImplementation(async () => [
      makeBackfilledMessage({
        id: "1700000000.000001",
        text: "New Assistant Thread",
        sender: { id: "B_ASSISTANT", name: "Ada" },
        metadata: { isBot: true, slackBotId: "B_ASSISTANT" },
      }),
      makeBackfilledMessage({
        id: "1700000000.000002",
        text: "real bot context",
        sender: { id: "B_ASSISTANT", name: "Ada" },
        metadata: { isBot: true, slackBotId: "B_ASSISTANT" },
      }),
      makeBackfilledMessage({
        id: "1700000000.000003",
        text: "New Assistant Thread",
        sender: { id: "B_OTHER", name: "Build Bot" },
        metadata: { isBot: true, slackBotId: "B_OTHER" },
      }),
    ]);

    await handleChannelInbound(
      buildDmRequest("live new DM"),
      noopProcessMessage,
      TEST_BEARER_TOKEN,
    );

    const rows = readPersistedSlackRows();
    expect(rows.map((row) => row.rawContent).sort()).toEqual([
      "New Assistant Thread",
      "real bot context",
    ]);
    expect(
      rows.some((row) => row.slackMeta?.actorExternalUserId === "B_OTHER"),
    ).toBe(true);
  });

  test("backfill skips channelTs values already stored", async () => {
    // First DM: backfill returns three rows.
    backfillDmMock.mockImplementation(async () => [
      makeBackfilledMessage({ id: "1700000000.000001", text: "older A" }),
      makeBackfilledMessage({ id: "1700000000.000002", text: "older B" }),
    ]);
    await handleChannelInbound(
      buildDmRequest("first live DM"),
      noopProcessMessage,
      TEST_BEARER_TOKEN,
    );
    expect(readPersistedSlackRows().length).toBe(2);

    // Conversation now has 2 slackMeta rows — still under the warm
    // threshold, so a second cold-path probe should fire. This time
    // backfill returns an overlapping set; only the new ts is written.
    backfillDmMock.mockImplementation(async () => [
      makeBackfilledMessage({ id: "1700000000.000001", text: "older A again" }),
      makeBackfilledMessage({ id: "1700000000.000004", text: "older D" }),
    ]);
    await handleChannelInbound(
      buildDmRequest("second live DM"),
      noopProcessMessage,
      TEST_BEARER_TOKEN,
    );
    expect(backfillDmMock).toHaveBeenCalledTimes(2);

    const rows = readPersistedSlackRows();
    expect(rows.length).toBe(3);
    const texts = rows.map((r) => r.content).sort();
    expect(texts).toEqual(["older A", "older B", "older D"]);
  });
});
