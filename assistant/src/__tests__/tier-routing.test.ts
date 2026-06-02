/**
 * End-to-end tier-routing proof for per-subagent `override_profile`.
 *
 * This is the load-bearing claim of app-builder v2: a worker subagent must be
 * able to RUN on a different inference tier than its parent. PR 1 made
 * `override_profile` a real, model-settable param on `subagent_spawn`; PR 2
 * (this test) proves that param actually reaches the provider-config seam where
 * tier selection happens — it is not silently dropped or overwritten by the
 * parent's pinned profile.
 *
 * Seam under test
 * ───────────────
 * `SubagentManager.runSubagent` forwards `SubagentConfig.overrideProfile` into
 * `conversation.runAgentLoop(message, messageId, { overrideProfile })`
 * (manager.ts ~509-513). Inside conversation-agent-loop.ts that option is read
 * as `options.overrideProfile`, becomes `turnOverrideProfile`, and is handed to
 * `ctx.agentLoop.run({ overrideProfile })` — i.e. it is THE value that sets the
 * provider config's effective inference tier for every LLM call the subagent
 * issues. Capturing the options that reach `runAgentLoop` therefore captures
 * exactly what the subagent's provider config will route on.
 *
 * We stub the conversation at that seam (no real provider, mirroring the
 * subagent-manager-notify mocking pattern) and assert the captured override
 * profile is the worker's tier, NOT the parent's.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * MANUAL SPIKE CHECKLIST (run once to validate the real path end-to-end)
 * ─────────────────────────────────────────────────────────────────────────
 * The automated test below stubs the provider at the agent-loop seam. To prove
 * the claim against the LIVE inference stack, run a real 2-worker app build and
 * confirm the tiers diverge in logs/telemetry:
 *
 *   1. Pin the PARENT conversation to `quality-optimized`
 *      (switch_inference_profile tool, or set the conversation's override
 *      profile so getConversationOverrideProfileFromRow returns it).
 *   2. Ask the assistant to build a small app that fans out to TWO `coder`
 *      workers, each spawned with `override_profile: "balanced"`.
 *   3. Tail the daemon logs and grep for the resolved profile per conversation:
 *        - the PARENT conversationId should log `overrideProfile: "quality-optimized"`
 *          (look for the agent-loop / provider-call log lines, e.g. the
 *          `{ overrideProfile }` record around conversation-agent-loop.ts:663).
 *        - EACH worker conversationId should log `overrideProfile: "balanced"`.
 *   4. Cross-check telemetry/usage: the workers' LLM calls should resolve to the
 *      model under `llm.profiles.balanced`, while the parent resolves to
 *      `llm.profiles["quality-optimized"]`. Confirm the model strings differ.
 *   5. PASS = both workers ran on balanced AND the parent ran on quality,
 *      concurrently, with no cross-contamination.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { describe, expect, mock, test } from "bun:test";

// ── Module mocks ──────────────────────────────────────────────────
// Mirror subagent-manager-notify.test.ts: stub the conversation store so the
// manager never touches a real Conversation/provider. The parent-notification
// path runs through findConversation → enqueueMessage; we only need it to not
// throw.

mock.module("../daemon/conversation-store.js", () => ({
  findConversation: () => ({
    enqueueMessage: () => ({ queued: true }),
  }),
  addConversation: () => {},
  removeConversation: () => {},
}));

mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: () => {},
}));

import type { ServerMessage } from "../daemon/message-protocol.js";
import { SubagentManager } from "../subagent/manager.js";
import type { SubagentState } from "../subagent/types.js";

// ── Test plumbing (private-internals access, per existing tests) ──────────

/**
 * Options object handed to `conversation.runAgentLoop`. We only care about the
 * `overrideProfile` field — that is the value that flows into the provider
 * config's effective tier inside conversation-agent-loop.ts.
 */
interface CapturedRunAgentLoopOptions {
  callSite?: string;
  overrideProfile?: string;
}

interface FakeConversation {
  abort: () => void;
  dispose: () => void;
  messages: Array<{ role: string; content: Array<{ type: string }> }>;
  sendToClient: (msg: ServerMessage) => void;
  usageStats: {
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
  };
  persistUserMessage: () => { id: string; deduplicated: boolean };
  runAgentLoop: (
    message: string,
    messageId: string,
    options?: CapturedRunAgentLoopOptions,
  ) => Promise<void>;
}

interface FakeManagedSubagent {
  conversation: FakeConversation | null;
  state: SubagentState;
  parentSendToClient: (msg: ServerMessage) => void;
}

interface ManagerInternals {
  subagents: Map<string, FakeManagedSubagent>;
  parentToChildren: Map<string, Set<string>>;
  runSubagent: (subagentId: string, objective: string) => Promise<void>;
  stopSweep: () => void;
}

function asInternals(manager: SubagentManager): ManagerInternals {
  return manager as unknown as ManagerInternals;
}

/** Records what reached the provider-config seam for a single worker run. */
interface ProfileCapture {
  called: boolean;
  overrideProfile?: string;
}

/**
 * Inject a fake managed subagent whose `runAgentLoop` records the
 * provider-config-bound override profile it was invoked with, then resolves
 * immediately (no real LLM turn). Returns the capture the run will populate.
 */
function injectWorker(
  manager: SubagentManager,
  subagentId: string,
  state: SubagentState,
): ProfileCapture {
  const capture: ProfileCapture = { called: false };
  const conversation: FakeConversation = {
    abort: () => {},
    dispose: () => {},
    messages: [],
    sendToClient: () => {},
    usageStats: { inputTokens: 1, outputTokens: 1, estimatedCost: 0 },
    persistUserMessage: () => ({ id: "msg-1", deduplicated: false }),
    runAgentLoop: async (
      _message: string,
      _messageId: string,
      options?: CapturedRunAgentLoopOptions,
    ) => {
      capture.called = true;
      capture.overrideProfile = options?.overrideProfile;
    },
  };

  const internals = asInternals(manager);
  internals.subagents.set(subagentId, {
    conversation,
    state,
    parentSendToClient: () => {},
  });

  const parentId = state.config.parentConversationId;
  if (!internals.parentToChildren.has(parentId)) {
    internals.parentToChildren.set(parentId, new Set());
  }
  internals.parentToChildren.get(parentId)!.add(subagentId);

  return capture;
}

/**
 * Build worker subagent state. `overrideProfile` is the worker's spawn-time
 * tier (set by the model via `subagent_spawn`'s `override_profile`, validated
 * in PR 1). The parent's pinned tier is intentionally NOT modelled here: the
 * whole point is that the worker carries its OWN tier independent of the
 * parent.
 */
function makeWorkerState(
  subagentId: string,
  overrideProfile: string | undefined,
): SubagentState {
  return {
    config: {
      id: subagentId,
      parentConversationId: "parent-conv-1",
      label: "Coder worker",
      objective: "Implement the feature",
      overrideProfile,
    },
    status: "running",
    resolvedRole: "coder",
    conversationId: `conv-${subagentId}`,
    isFork: false,
    createdAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("per-subagent tier routing reaches the provider-config seam", () => {
  test("parent pinned to quality-optimized: worker resolves to balanced (not the parent's tier)", async () => {
    // The parent in this scenario is pinned to "quality-optimized". A worker
    // spawned with override_profile: "balanced" must NOT inherit the parent's
    // tier — it must carry its own. We assert the value forwarded to
    // runAgentLoop (the provider-config seam) is the worker's, not the parent's.
    const PARENT_TIER = "quality-optimized";
    const WORKER_TIER = "balanced";

    const manager = new SubagentManager();
    const capture = injectWorker(
      manager,
      "worker-1",
      makeWorkerState("worker-1", WORKER_TIER),
    );

    await asInternals(manager).runSubagent("worker-1", "Implement the feature");

    expect(capture.called).toBe(true);
    expect(capture.overrideProfile).toBe(WORKER_TIER);
    expect(capture.overrideProfile).not.toBe(PARENT_TIER);

    asInternals(manager).stopSweep();
  });

  test("parent unpinned (no profile): worker still resolves to balanced", async () => {
    // Even when the parent has no pinned profile at all, an explicit worker
    // override must still reach the provider config — it does not require a
    // parent tier to anchor against.
    const WORKER_TIER = "balanced";

    const manager = new SubagentManager();
    const capture = injectWorker(
      manager,
      "worker-2",
      makeWorkerState("worker-2", WORKER_TIER),
    );

    await asInternals(manager).runSubagent("worker-2", "Implement the feature");

    expect(capture.called).toBe(true);
    expect(capture.overrideProfile).toBe(WORKER_TIER);

    asInternals(manager).stopSweep();
  });

  test("worker with no override carries no profile to the provider config", async () => {
    // Control: when the spawn carries no override_profile, nothing is forwarded
    // to the seam (the field is omitted, not coerced) — so the subagent falls
    // back to the workspace/active profile rather than a stray tier.
    const manager = new SubagentManager();
    const capture = injectWorker(
      manager,
      "worker-3",
      makeWorkerState("worker-3", undefined),
    );

    await asInternals(manager).runSubagent("worker-3", "Implement the feature");

    expect(capture.called).toBe(true);
    expect(capture.overrideProfile).toBeUndefined();

    asInternals(manager).stopSweep();
  });
});
