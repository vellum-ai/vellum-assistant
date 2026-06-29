/**
 * Post-compaction re-injection idempotency.
 *
 * The agent loop hands the post-compaction hook the full injected continuation
 * history (it does not pre-strip it), so the hook must clear the tail's stale
 * per-turn injection blocks before re-applying them. Without that strip,
 * `applyRuntimeInjections` double-stacks every non-presence-gated block —
 * `<turn_context>`, `<config_reset_notice>`, `<active_documents>`,
 * `<document_comments>` — because it appends to the tail without removing an
 * existing copy. These tests cover the strip primitive directly and the
 * end-to-end re-injection it protects.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  clearConversations,
  setConversation,
} from "../daemon/conversation-registry.js";
import { applyRuntimeInjections } from "../daemon/conversation-runtime-assembly.js";
import { registerDefaultPluginInjectors } from "../plugins/defaults/index.js";
import { stripTailInjectionsForReinjection } from "../plugins/defaults/memory/tail-reinjection-strip.js";
import type { Message } from "../providers/types.js";

// Populate the injector registry with the default plugins' injectors the way
// bootstrap does in production, so `applyRuntimeInjections` walks a non-empty
// chain. This suite has no `beforeEach`, so registering at module load (before
// any test runs) is sufficient.
registerDefaultPluginInjectors();

const WORKSPACE_BLOCK = "<workspace>\nRoot: /sandbox\n</workspace>";
const INFO_BLOCK = "<info>\nRemembered fact about project-x\n</info>";
const TURN_CONTEXT_BLOCK =
  "<turn_context>\ncurrent_time: noon\n</turn_context>";
const CONFIG_RESET_BLOCK =
  "<config_reset_notice>\nSettings were reset.\n</config_reset_notice>";
const ACTIVE_DOCUMENTS_BLOCK =
  "<active_documents>\nThe following documents are open: notes.md\n</active_documents>";
const DOCUMENT_COMMENTS_BLOCK =
  "<document_comments>\nOpen comments on notes.md\n</document_comments>";
const TURN_BODY = "Please continue the task.";

function userMsg(...texts: string[]): Message {
  return {
    role: "user",
    content: texts.map((text) => ({ type: "text" as const, text })),
  };
}

function assistantMsg(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function tailContentTexts(messages: Message[]): string[] {
  const last = messages[messages.length - 1];
  return last.content.map((block) => (block.type === "text" ? block.text : ""));
}

function countTailBlocksWithPrefix(
  messages: Message[],
  prefix: string,
): number {
  return tailContentTexts(messages).filter((text) => text.startsWith(prefix))
    .length;
}

describe("stripTailInjectionsForReinjection", () => {
  test("clears every per-turn injection block from the tail user message", () => {
    // GIVEN a tail user message carrying the real turn body plus the full
    // per-turn injection set, including the four blocks compaction keeps in
    // durable history
    const messages: Message[] = [
      userMsg(
        TURN_BODY,
        WORKSPACE_BLOCK,
        INFO_BLOCK,
        TURN_CONTEXT_BLOCK,
        CONFIG_RESET_BLOCK,
        ACTIVE_DOCUMENTS_BLOCK,
        DOCUMENT_COMMENTS_BLOCK,
      ),
    ];

    // WHEN the tail injections are stripped for re-injection
    const result = stripTailInjectionsForReinjection(messages);

    // THEN only the real turn body survives on the tail
    expect(tailContentTexts(result)).toEqual([TURN_BODY]);
  });

  test("leaves injection blocks on earlier messages untouched", () => {
    // GIVEN an earlier user message and the tail both carrying a turn-context
    // block
    const messages: Message[] = [
      userMsg("Earlier turn", TURN_CONTEXT_BLOCK),
      assistantMsg("Working on it."),
      userMsg(TURN_BODY, TURN_CONTEXT_BLOCK),
    ];

    // WHEN the tail injections are stripped
    const result = stripTailInjectionsForReinjection(messages);

    // THEN the earlier message keeps its historical turn-context grounding
    expect(result[0].content).toHaveLength(2);
    expect((result[0].content[1] as { text: string }).text).toBe(
      TURN_CONTEXT_BLOCK,
    );
    // AND only the tail is cleared
    expect(tailContentTexts(result)).toEqual([TURN_BODY]);
  });

  test("returns the messages unchanged when the tail carries no injections", () => {
    // GIVEN a tail with only real user content
    const messages: Message[] = [userMsg(TURN_BODY)];

    // WHEN the tail injections are stripped
    const result = stripTailInjectionsForReinjection(messages);

    // THEN the array is returned unchanged
    expect(result).toBe(messages);
  });

  test("preserves the tail user message even when every block is stripped", () => {
    // GIVEN a tail composed entirely of injection blocks
    const messages: Message[] = [
      assistantMsg("Earlier reply."),
      userMsg(WORKSPACE_BLOCK, TURN_CONTEXT_BLOCK),
    ];

    // WHEN the tail injections are stripped
    const result = stripTailInjectionsForReinjection(messages);

    // THEN the tail user message remains so the re-injection tail invariant
    // holds, just with empty content
    expect(result).toHaveLength(2);
    expect(result[1].role).toBe("user");
    expect(result[1].content).toHaveLength(0);
  });

  test("is idempotent — stripping an already-stripped tail is a no-op", () => {
    // GIVEN a tail that has already been stripped once
    const messages: Message[] = [userMsg(TURN_BODY, TURN_CONTEXT_BLOCK)];
    const once = stripTailInjectionsForReinjection(messages);

    // WHEN it is stripped again
    const twice = stripTailInjectionsForReinjection(once);

    // THEN the second strip changes nothing
    expect(twice).toBe(once);
    expect(tailContentTexts(twice)).toEqual([TURN_BODY]);
  });
});

describe("applyRuntimeInjections re-injection idempotency", () => {
  // `applyRuntimeInjections` synthesizes this conversation id when no
  // turnContext is supplied, so the injectors resolve their blocks from the
  // registry under this key.
  const FALLBACK_CONVERSATION_ID = "runtime-assembly-fallback";

  // Seed the fallback conversation with a workspace block (presence-gated) and
  // a frozen temporal snapshot so the non-presence-gated `<turn_context>` block
  // is produced every assembly.
  function seedConversation(): void {
    setConversation(FALLBACK_CONVERSATION_ID, {
      conversationId: FALLBACK_CONVERSATION_ID,
      workingDir: "/sandbox",
      workspaceTopLevelContext: WORKSPACE_BLOCK,
      workspaceTopLevelDirty: false,
      currentTurnTemporalSnapshot: { clientTimezone: null },
    } as never);
  }

  afterEach(() => {
    clearConversations();
  });

  test("re-injecting an already-injected base without the strip double-stacks the non-presence-gated block", async () => {
    // GIVEN a fresh turn assembled once, so its tail carries one workspace and
    // one turn-context block
    seedConversation();
    const { messages: injectedOnce } = await applyRuntimeInjections(
      [userMsg(TURN_BODY)],
      { conversationId: FALLBACK_CONVERSATION_ID },
    );
    expect(countTailBlocksWithPrefix(injectedOnce, "<turn_context>")).toBe(1);

    // WHEN injections are applied again to that already-injected base
    const { messages: injectedTwice } = await applyRuntimeInjections(
      injectedOnce,
      { conversationId: FALLBACK_CONVERSATION_ID },
    );

    // THEN the non-presence-gated turn-context block double-stacks
    expect(countTailBlocksWithPrefix(injectedTwice, "<turn_context>")).toBe(2);
    // AND the presence-gated workspace block stays single
    expect(countTailBlocksWithPrefix(injectedTwice, "<workspace>")).toBe(1);
  });

  test("stripping the tail before re-injecting keeps every block single", async () => {
    // GIVEN a fresh turn assembled once
    seedConversation();
    const { messages: injectedOnce } = await applyRuntimeInjections(
      [userMsg(TURN_BODY)],
      { conversationId: FALLBACK_CONVERSATION_ID },
    );

    // WHEN the tail is stripped before re-injection, exactly as the
    // post-compaction hook does
    const { messages: reinjected } = await applyRuntimeInjections(
      stripTailInjectionsForReinjection(injectedOnce),
      { conversationId: FALLBACK_CONVERSATION_ID },
    );

    // THEN both the non-presence-gated and presence-gated blocks stay single
    expect(countTailBlocksWithPrefix(reinjected, "<turn_context>")).toBe(1);
    expect(countTailBlocksWithPrefix(reinjected, "<workspace>")).toBe(1);
    // AND the real turn body survives
    expect(
      tailContentTexts(reinjected).some((text) => text === TURN_BODY),
    ).toBe(true);
  });
});
