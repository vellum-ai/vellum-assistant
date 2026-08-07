/**
 * The `title-generation-unavailable` injector.
 *
 * Titling is fire-and-forget, so a failure cannot be reported during the turn
 * that caused it. This injector is the other half of that: it carries an
 * already-observed fault into a later turn. What matters is the gating: the
 * notice must reach a turn that would genuinely have been titled, exactly
 * once, and must stop entirely once titling works.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { stripInjectionsForCompaction } from "../daemon/conversation-runtime-assembly.js";
import {
  clearTitleModelFault,
  recordTitleModelFault,
} from "../persistence/conversation-title-health.js";
import {
  AUTO_TITLE_DETERMINISTIC,
  AUTO_TITLE_LLM,
} from "../persistence/conversation-title-service.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { conversations } from "../persistence/schema/index.js";
import { titleGenerateInjectors } from "../plugins/defaults/title-generate/injectors.js";
import type { Injector, TurnContext } from "../plugins/types.js";
import type { Message } from "../providers/types.js";

await initializeDb();

const injector: Injector = (() => {
  const found = titleGenerateInjectors.find(
    (candidate) => candidate.name === "title-generation-unavailable",
  );
  if (!found) {
    throw new Error("title-generation-unavailable injector not registered");
  }
  return found;
})();

const FAULT = {
  model: "gpt-5.4-nano",
  provider: "openai",
  connectionName: "openai-codex",
};

function makeContext(conversationId: string): TurnContext {
  return {
    requestId: "req-test",
    conversationId,
    turnIndex: 0,
    trust: { sourceChannel: "vellum", trustClass: "guardian" },
  };
}

/** Seed a conversation row with the given title state. */
function seedConversation(
  id: string,
  title: string | null,
  isAutoTitle: number,
): void {
  const now = Date.now();
  const db = getDb();
  db.delete(conversations).where(eq(conversations.id, id)).run();
  db.insert(conversations)
    .values({ id, title, isAutoTitle, createdAt: now, updatedAt: now })
    .run();
}

beforeEach(() => {
  clearTitleModelFault();
});

describe("title-generation-unavailable injector", () => {
  test("says nothing while titling is healthy or untested", async () => {
    seedConversation("conv-healthy", "Untitled Conversation", AUTO_TITLE_LLM);
    await expect(
      injector.produce(makeContext("conv-healthy")),
    ).resolves.toBeNull();
  });

  test("reports a latched fault, naming the model and connection", async () => {
    seedConversation("conv-a", "Untitled Conversation", AUTO_TITLE_LLM);
    recordTitleModelFault(FAULT);

    const block = await injector.produce(makeContext("conv-a"));

    expect(block?.id).toBe("title-generation-unavailable");
    expect(block?.placement).toBe("prepend-user-tail");
    expect(block?.text).toContain("<title_generation_unavailable>");
    expect(block?.text).toContain("gpt-5.4-nano");
    expect(block?.text).toContain("openai-codex");
  });

  test("emits at most once per conversation", async () => {
    // A failed title leaves the conversation replaceable, so the "would we
    // title this" gate stays true for every later turn. Without the claim
    // ledger the notice would ride along with every message the user sends.
    seedConversation("conv-b", "Untitled Conversation", AUTO_TITLE_LLM);
    recordTitleModelFault(FAULT);

    expect(await injector.produce(makeContext("conv-b"))).not.toBeNull();
    expect(await injector.produce(makeContext("conv-b"))).toBeNull();
    expect(await injector.produce(makeContext("conv-b"))).toBeNull();
  });

  test("the once-per-conversation limit is per conversation, not global", async () => {
    seedConversation("conv-c", "Untitled Conversation", AUTO_TITLE_LLM);
    seedConversation("conv-d", "Untitled Conversation", AUTO_TITLE_LLM);
    recordTitleModelFault(FAULT);

    expect(await injector.produce(makeContext("conv-c"))).not.toBeNull();
    expect(await injector.produce(makeContext("conv-d"))).not.toBeNull();
  });

  test("stays silent on a conversation that would not be titled anyway", async () => {
    // A user-named conversation never spends a title call, so a titling fault
    // is not something this turn was about to hit.
    seedConversation("conv-named", "Quarterly planning", 0);
    recordTitleModelFault(FAULT);

    await expect(
      injector.produce(makeContext("conv-named")),
    ).resolves.toBeNull();
  });

  test("speaks up for a deterministic bootstrap title, which is still upgradeable", async () => {
    seedConversation(
      "conv-bootstrap",
      "Heartbeat run",
      AUTO_TITLE_DETERMINISTIC,
    );
    recordTitleModelFault(FAULT);

    await expect(
      injector.produce(makeContext("conv-bootstrap")),
    ).resolves.not.toBeNull();
  });

  test("stays silent for a conversation that does not exist", async () => {
    recordTitleModelFault(FAULT);
    await expect(
      injector.produce(makeContext("conv-missing")),
    ).resolves.toBeNull();
  });

  test("stops entirely once titling succeeds", async () => {
    seedConversation("conv-e", "Untitled Conversation", AUTO_TITLE_LLM);
    recordTitleModelFault(FAULT);
    clearTitleModelFault();

    await expect(injector.produce(makeContext("conv-e"))).resolves.toBeNull();
  });

  test("a different fault re-arms conversations already told about the old one", async () => {
    seedConversation("conv-f", "Untitled Conversation", AUTO_TITLE_LLM);
    recordTitleModelFault(FAULT);
    expect(await injector.produce(makeContext("conv-f"))).not.toBeNull();
    expect(await injector.produce(makeContext("conv-f"))).toBeNull();

    recordTitleModelFault({ ...FAULT, model: "gpt-5.4-mini" });
    const block = await injector.produce(makeContext("conv-f"));
    expect(block?.text).toContain("gpt-5.4-mini");
  });

  test("re-recording the same fault does not re-arm", async () => {
    seedConversation("conv-g", "Untitled Conversation", AUTO_TITLE_LLM);
    recordTitleModelFault(FAULT);
    expect(await injector.produce(makeContext("conv-g"))).not.toBeNull();

    recordTitleModelFault({ ...FAULT });
    expect(await injector.produce(makeContext("conv-g"))).toBeNull();
  });

  test("compaction strips the block", async () => {
    // The claim ledger guards emission, not history. A compaction that
    // rewrote the block into a summary would outlive the one claim.
    seedConversation("conv-h", "Untitled Conversation", AUTO_TITLE_LLM);
    recordTitleModelFault(FAULT);
    const block = await injector.produce(makeContext("conv-h"));

    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: block!.text },
          { type: "text", text: "what's the weather" },
        ],
      },
    ];

    const stripped = stripInjectionsForCompaction(messages);
    expect(stripped[0].content).toEqual([
      { type: "text", text: "what's the weather" },
    ]);
  });
});
