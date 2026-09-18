import { beforeEach, describe, expect, test } from "bun:test";

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

async function persistUnder(
  trustContext: TrustContext | undefined,
): Promise<ReturnType<typeof parseMessageMetadata>> {
  const conversation = createConversation("provenance-contact-id");
  const row = await addMessage(conversation.id, "user", "hello", {
    metadata: provenanceFromTrustContext(trustContext),
  });
  const stored = getMessageById(row.id, conversation.id);
  return parseMessageMetadata(stored?.metadata ?? null);
}

describe("message provenance contact id", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM messages`);
    db.run(`DELETE FROM conversations`);
  });

  test("a row records the contact its turn's actor resolved to", async () => {
    const metadata = await persistUnder({
      sourceChannel: "slack",
      trustClass: "trusted_contact",
      requesterIdentifier: "@alice",
      requesterContactId: "contact-alice",
    });

    expect(metadata?.provenanceTrustClass).toBe("trusted_contact");
    expect(metadata?.provenanceContactId).toBe("contact-alice");
  });

  test("an actor with no resolved contact leaves the field absent", async () => {
    const metadata = await persistUnder({
      sourceChannel: "slack",
      trustClass: "unknown",
    });

    expect(metadata?.provenanceTrustClass).toBe("unknown");
    expect(metadata?.provenanceContactId).toBeUndefined();
  });

  test("a row with no trust context names no contact", async () => {
    const metadata = await persistUnder(undefined);

    expect(metadata?.provenanceTrustClass).toBe("unknown");
    expect(metadata?.provenanceContactId).toBeUndefined();
  });
});
