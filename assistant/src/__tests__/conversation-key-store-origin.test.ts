/**
 * The key store attributes a channel conversation when it materializes it.
 *
 * This is the principal inbound seam: a new Slack, Telegram, or phone
 * conversation gets its row here, before the daemon's own creation path is
 * ever consulted. Stamping only in `createConversation` therefore misses the
 * case that matters most, which is why these cases exist separately.
 *
 * The trust assertion at the end is the one worth protecting. `origin_channel`
 * is what `recoverRestingTrustContext` reads, and the native channel recovers
 * INTERNAL_GUARDIAN_TRUST_CONTEXT on every later wake and boot-resume. A
 * remote conversation that reached this seam unattributed, or attributed as
 * native, would resume as the guardian's own.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { recoverRestingTrustContext } from "../daemon/conversation-resting-trust.js";
import { setConversationOriginChannelIfUnset } from "../persistence/conversation-crud.js";
import { getOrCreateConversation } from "../persistence/conversation-key-store.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { conversations } from "../persistence/schema/index.js";

await initializeDb();

function rawOriginChannel(id: string): string | null {
  const row = getDb()
    .all(`SELECT origin_channel FROM conversations WHERE id = '${id}'`)
    .at(0) as { origin_channel: string | null } | undefined;
  return row?.origin_channel ?? null;
}

beforeEach(() => {
  getDb().delete(conversations).run();
});

describe("materializing a conversation from a channel key", () => {
  test("stamps the channel at creation, before any message", () => {
    const { conversationId, created } = getOrCreateConversation(
      "default:slack:slack",
      { origin: "slack" },
    );

    expect(created).toBe(true);
    expect(rawOriginChannel(conversationId)).toBe("slack");
  });

  test("the first message does not change what creation established", () => {
    // Attribution is guarded on `IS NULL`, so a row attributed at creation is
    // never re-claimed. Before and after the first message agree.
    const { conversationId } = getOrCreateConversation("default:slack:slack", {
      origin: "slack",
    });
    const atCreation = rawOriginChannel(conversationId);

    setConversationOriginChannelIfUnset(conversationId, "telegram");

    expect(rawOriginChannel(conversationId)).toBe(atCreation);
    expect(rawOriginChannel(conversationId)).toBe("slack");
  });

  test("reusing an existing key does not re-attribute it", () => {
    const first = getOrCreateConversation("default:slack:slack", {
      origin: "slack",
    });

    const second = getOrCreateConversation("default:slack:slack", {
      origin: "vellum",
    });

    expect(second.created).toBe(false);
    expect(second.conversationId).toBe(first.conversationId);
    expect(rawOriginChannel(first.conversationId)).toBe("slack");
  });

  test("a caller that states no origin leaves the column unset", () => {
    const { conversationId } = getOrCreateConversation("some:other:key");

    expect(rawOriginChannel(conversationId)).toBeNull();
  });
});

describe("what the attribution protects", () => {
  test("a channel conversation recovers no resting trust", () => {
    // The property the whole change exists to hold. Driven through the
    // creation seam rather than a raw column write, so it fails if creation
    // ever stops attributing the row.
    const { conversationId } = getOrCreateConversation("default:slack:slack", {
      origin: "slack",
    });

    expect(recoverRestingTrustContext(conversationId)).toBeNull();
  });

  test("a native conversation still recovers guardian trust", () => {
    // The other half: attributing at creation must not withdraw trust from
    // the guardian's own conversations, or every local wake regresses.
    const { conversationId } = getOrCreateConversation("native-key", {
      origin: "vellum",
    });

    expect(recoverRestingTrustContext(conversationId)).not.toBeNull();
  });
});
