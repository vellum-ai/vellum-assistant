/**
 * The duplex continuation's fork parent is hydrated under resolved guardian
 * trust.
 *
 * `Conversation.loadFromDb` filters history by the instance's own trust class:
 * a load with no trust context resolves the fail-closed `unknown` capability
 * set, which drops memory blocks and forces the in-context compaction summary
 * to null. `defaultSpawnBackgroundContinuation` snapshots the parent's messages
 * straight into the fork, so an unstamped load would hand the continuation a
 * lobotomized view of the very turn it is meant to finish. These tests pin the
 * ordering (resolve trust → stamp → load) and the restore that keeps the
 * bridge's per-turn ownership of the parent's trust intact.
 *
 * `mock.module` is process-global in Bun and leaks into sibling files that run
 * later in the same `bun test` invocation, so every stub delegates to the real
 * implementation unless this file's tests are active (`forkMocksActive`,
 * toggled in beforeAll/afterAll). Run this file on its own.
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

import type { Conversation } from "../../daemon/conversation.js";
import type { TrustContext } from "../../daemon/trust-context-types.js";
import type { Message } from "../../providers/types.js";
import type { TrustClass } from "../../runtime/trust-class.js";

let forkMocksActive = false;

// Snapshotted into plain objects NOW, before the stubs register — a module
// namespace is a live view, so reading the real export after the stub installs
// would resolve back to the stub (infinite recursion).
const realConversationStoreModule = {
  ...(await import("../../daemon/conversation-store.js")),
};
const realLocalActorIdentityModule = {
  ...(await import("../../runtime/local-actor-identity.js")),
};
const realLocalPrincipalTrustModule = {
  ...(await import("../../runtime/local-principal-trust.js")),
};
const realSubagentModule = { ...(await import("../../subagent/index.js")) };

const PARENT_CONVERSATION_ID = "conversation-fork-parent";
const GUARDIAN_PRINCIPAL_ID = "principal-guardian-1";

function textMessage(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

/** What a trusted `loadFromDb` puts into the parent's in-memory history. */
const HYDRATED_MESSAGES: Message[] = [
  textMessage("persisted-turn"),
  textMessage("memory-block"),
];

/**
 * Stands in for the resident `Conversation` the spawn helper snapshots. Only
 * the surface `defaultSpawnBackgroundContinuation` touches is modelled, mirroring
 * the real trust-class bookkeeping: `loadFromDb` records the trust context in
 * force at the instant it runs and remembers the class it loaded under, and
 * `ensureActorScopedHistory` reloads only when the current class differs.
 */
class FakeParentConversation {
  trustContext: TrustContext | undefined;
  /** The instance's trust context as observed inside each `loadFromDb` call. */
  readonly loadTrustContexts: (TrustContext | undefined)[] = [];
  private messages: Message[];
  private loadedHistoryTrustClass: TrustClass | undefined;

  constructor(messages: Message[] = [], loadedAs?: TrustClass) {
    this.messages = messages;
    this.loadedHistoryTrustClass = loadedAs;
  }

  setTrustContext(ctx: TrustContext | null): void {
    this.trustContext = ctx ?? undefined;
  }

  getMessages(): Message[] {
    return this.messages;
  }

  getCurrentSystemPrompt(): string {
    return "parent-system-prompt";
  }

  async ensureActorScopedHistory(): Promise<void> {
    if (this.loadedHistoryTrustClass === this.trustContext?.trustClass) {
      return;
    }
    await this.loadFromDb();
  }

  async loadFromDb(): Promise<{
    rows: never[];
    rowToHistoryIndex: null;
  }> {
    this.loadTrustContexts.push(this.trustContext);
    this.loadedHistoryTrustClass = this.trustContext?.trustClass;
    this.messages = [...HYDRATED_MESSAGES];
    return { rows: [], rowToHistoryIndex: null };
  }
}

// -- Mutable stub state -------------------------------------------------------

/** The conversation `getOrCreateConversation` hands back. */
let parentConversation: FakeParentConversation;
/** `undefined` models an assistant with no local guardian binding. */
let guardianPrincipalId: string | undefined;
/** Trust class the local principal resolver returns for that guardian. */
let resolvedTrustClass: TrustClass;
/** Configs passed to `spawnAndAwait`, in call order. */
let spawnConfigs: { trustContext?: TrustContext; parentMessages?: Message[] }[];

mock.module("../../daemon/conversation-store.js", () => ({
  ...realConversationStoreModule,
  getOrCreateConversation: async (conversationId: string) =>
    forkMocksActive
      ? (parentConversation as unknown as Conversation)
      : realConversationStoreModule.getOrCreateConversation(conversationId),
}));

mock.module("../../runtime/local-actor-identity.js", () => ({
  ...realLocalActorIdentityModule,
  findLocalGuardianPrincipalId: async () =>
    forkMocksActive
      ? guardianPrincipalId
      : realLocalActorIdentityModule.findLocalGuardianPrincipalId(),
}));

mock.module("../../runtime/local-principal-trust.js", () => ({
  ...realLocalPrincipalTrustModule,
  resolveLocalPrincipalTrustContext: async (
    input: Parameters<
      typeof realLocalPrincipalTrustModule.resolveLocalPrincipalTrustContext
    >[0],
  ) => {
    if (!forkMocksActive) {
      return realLocalPrincipalTrustModule.resolveLocalPrincipalTrustContext(
        input,
      );
    }
    return {
      sourceChannel: "vellum",
      trustClass: resolvedTrustClass,
      guardianPrincipalId: input.actorPrincipalId,
    } satisfies TrustContext;
  },
}));

mock.module("../../subagent/index.js", () => ({
  ...realSubagentModule,
  getSubagentManager: () =>
    forkMocksActive
      ? {
          spawnAndAwait: async (config: {
            trustContext?: TrustContext;
            parentMessages?: Message[];
          }) => {
            spawnConfigs.push(config);
            return "continuation answer";
          },
        }
      : realSubagentModule.getSubagentManager(),
}));

import { defaultSpawnBackgroundContinuation } from "../live-voice-session.js";

async function spawnContinuation(): Promise<string> {
  return await defaultSpawnBackgroundContinuation({
    parentConversationId: PARENT_CONVERSATION_ID,
    objective: "finish the interrupted build",
    label: "continuation",
    signal: new AbortController().signal,
  });
}

describe("duplex continuation fork-parent hydration", () => {
  beforeAll(() => {
    forkMocksActive = true;
  });

  afterAll(() => {
    forkMocksActive = false;
  });

  beforeEach(() => {
    parentConversation = new FakeParentConversation();
    guardianPrincipalId = GUARDIAN_PRINCIPAL_ID;
    resolvedTrustClass = "guardian";
    spawnConfigs = [];
  });

  test("loads a cold parent under the resolved guardian trust", async () => {
    await spawnContinuation();

    // The trust context in force AT LOAD TIME is what `loadFromDb` filters
    // against, so resolving trust after the hydration would not help.
    expect(parentConversation.loadTrustContexts).toHaveLength(1);
    expect(parentConversation.loadTrustContexts[0]).toBeDefined();
    expect(parentConversation.loadTrustContexts[0]?.trustClass).toBe(
      "guardian",
    );
    expect(spawnConfigs[0]?.parentMessages).toEqual(HYDRATED_MESSAGES);
  });

  test("restores the parent's prior trust context after the load", async () => {
    const priorTrustContext: TrustContext = {
      sourceChannel: "vellum",
      trustClass: "guardian",
      guardianPrincipalId: "principal-prior",
    };
    parentConversation.setTrustContext(priorTrustContext);

    await spawnContinuation();

    expect(parentConversation.loadTrustContexts).toHaveLength(1);
    // The bridge owns this conversation's trust per-turn; the stamp must not
    // outlive the load.
    expect(parentConversation.trustContext).toBe(priorTrustContext);
  });

  test("clears the stamp when the parent had no trust context", async () => {
    await spawnContinuation();

    expect(parentConversation.trustContext).toBeUndefined();
  });

  test("reloads a parent that was hydrated with no trust context", async () => {
    // Warm instance: `getOrCreateConversation` already loaded it, but without a
    // trust context — so its history may be trust-filtered and cannot be forked
    // as-is.
    parentConversation = new FakeParentConversation([
      textMessage("filtered-history"),
    ]);

    await spawnContinuation();

    expect(parentConversation.loadTrustContexts).toHaveLength(1);
    expect(parentConversation.loadTrustContexts[0]?.trustClass).toBe(
      "guardian",
    );
    expect(spawnConfigs[0]?.parentMessages).toEqual(HYDRATED_MESSAGES);
  });

  test("leaves an already-guardian-scoped warm parent alone", async () => {
    parentConversation = new FakeParentConversation(
      [textMessage("warm")],
      "guardian",
    );

    await spawnContinuation();

    expect(parentConversation.loadTrustContexts).toHaveLength(0);
    expect(spawnConfigs[0]?.parentMessages).toEqual([textMessage("warm")]);
  });

  test("hydrates unstamped when no guardian trust resolves", async () => {
    guardianPrincipalId = undefined;

    await spawnContinuation();

    // Fail-closed by design: with no guardian binding there is nothing to stamp,
    // so the continuation runs as `unknown` exactly as an unstamped turn does.
    expect(parentConversation.loadTrustContexts).toEqual([undefined]);
    expect(parentConversation.trustContext).toBeUndefined();
    expect(spawnConfigs[0]?.trustContext).toBeUndefined();
  });

  test("does not stamp a non-guardian resolution", async () => {
    resolvedTrustClass = "unknown";

    await spawnContinuation();

    expect(parentConversation.loadTrustContexts).toEqual([undefined]);
    expect(spawnConfigs[0]?.trustContext).toBeUndefined();
  });
});
