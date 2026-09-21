import { beforeEach, describe, expect, test } from "bun:test";

import { actorAuthorProvenance } from "../daemon/message-provenance.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import {
  addMessage,
  createConversation,
  getMessageById,
  parseMessageMetadata,
  provenanceFromTrustContext,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";

await initializeDb();

const ALICE: TrustContext = {
  sourceChannel: "slack",
  trustClass: "trusted_contact",
  requesterIdentifier: "@alice",
  requesterContactId: "contact-alice",
};

async function persistWith(
  role: "user" | "assistant",
  metadata: Record<string, unknown>,
): Promise<ReturnType<typeof parseMessageMetadata>> {
  const conversation = createConversation("provenance-contact-id");
  const row = await addMessage(conversation.id, role, "hello", { metadata });
  const stored = getMessageById(row.id, conversation.id);
  return parseMessageMetadata(stored?.metadata ?? null);
}

describe("message provenance contact id", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM messages`);
    db.run(`DELETE FROM conversations`);
  });

  test("a person's own row names them as its author", async () => {
    const metadata = await persistWith("user", {
      ...provenanceFromTrustContext(ALICE),
      ...actorAuthorProvenance(ALICE),
    });

    expect(metadata?.provenanceTrustClass).toBe("trusted_contact");
    expect(metadata?.provenanceContactId).toBe("contact-alice");
  });

  test("a row written during their turn carries the turn's trust but no author", async () => {
    // The assistant's replies, tool results, and notices are stamped with the
    // turn's provenance alone.
    const metadata = await persistWith(
      "assistant",
      provenanceFromTrustContext(ALICE),
    );

    expect(metadata?.provenanceTrustClass).toBe("trusted_contact");
    expect(metadata?.provenanceContactId).toBeUndefined();
  });

  test("an actor with no resolved contact names no author", () => {
    expect(
      actorAuthorProvenance({ sourceChannel: "slack", trustClass: "unknown" }),
    ).toEqual({});
    expect(actorAuthorProvenance(undefined)).toEqual({});
  });
});
