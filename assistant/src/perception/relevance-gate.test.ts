import { describe, expect, test } from "bun:test";

import type { Provider } from "../providers/types.js";
import { AssistantEventHub } from "../runtime/assistant-event-hub.js";
import { PerceptionRelevanceGate } from "./relevance-gate.js";

function makeProvider(replyText: string): Provider {
  return {
    name: "test-provider",
    async sendMessage() {
      return {
        content: [{ type: "text", text: replyText }],
        model: "test-model",
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "stop",
      };
    },
  };
}

function makeTaskDetectedEvent(eventId = "task-1") {
  return {
    message: {
      type: "perception.task_detected",
      perception: {
        eventId,
        ts: "2026-05-15T05:00:00.000Z",
        source: { module: "skills/perception" },
        payload: {
          kind: "task_detected",
          label: "Debugging auth",
          summary: "User is debugging authentication issues",
          confidence: 0.92,
          sourceEventId: "focus-123",
        },
      },
    },
  };
}

function envelope(event: ReturnType<typeof makeTaskDetectedEvent>) {
  return {
    id: "inbound-evt",
    emittedAt: "2026-05-15T05:00:00.000Z",
    message: event.message,
  };
}

describe("PerceptionRelevanceGate", () => {
  test("invokes wake on act-now decision when within budget", async () => {
    const checkpoints = new Map<string, string>();
    const wakeCalls: Array<{ conversationId: string; hint: string }> = [];

    const gate = new PerceptionRelevanceGate({
      getProvider: async () =>
        makeProvider(
          JSON.stringify({
            decision: "act-now",
            urgency: "medium",
            reason: "Time-sensitive opportunity.",
          }),
        ),
      now: () => new Date("2026-05-15T05:00:10.000Z"),
      wakeAgent: async ({ conversationId, hint }) => {
        wakeCalls.push({ conversationId, hint });
        return { invoked: true, producedToolCalls: false };
      },
      bootstrapConversation: () => ({ id: "conv-1" }),
      getCheckpoint: (key) => checkpoints.get(key) ?? null,
      setCheckpoint: (key, value) => {
        checkpoints.set(key, value);
      },
    });

    await gate.ingest(makeTaskDetectedEvent());

    expect(wakeCalls).toHaveLength(1);
    const recorded = checkpoints.get("perception:act-now:hourly-timestamps");
    expect(recorded).not.toBeUndefined();
    expect(JSON.parse(recorded ?? "[]")).toHaveLength(1);
  });

  test("blocks medium urgency act-now when hourly budget is exhausted", async () => {
    const checkpoints = new Map<string, string>();
    checkpoints.set(
      "perception:act-now:hourly-timestamps",
      JSON.stringify([Date.parse("2026-05-15T04:40:00.000Z")]),
    );
    let wakeCount = 0;

    const gate = new PerceptionRelevanceGate({
      getProvider: async () =>
        makeProvider(
          JSON.stringify({
            decision: "act-now",
            urgency: "medium",
            reason: "Would be useful but not urgent.",
          }),
        ),
      now: () => new Date("2026-05-15T05:00:10.000Z"),
      hourlyActNowBudget: 1,
      wakeAgent: async () => {
        wakeCount += 1;
        return { invoked: true, producedToolCalls: false };
      },
      bootstrapConversation: () => ({ id: "conv-2" }),
      getCheckpoint: (key) => checkpoints.get(key) ?? null,
      setCheckpoint: (key, value) => {
        checkpoints.set(key, value);
      },
    });

    await gate.ingest(makeTaskDetectedEvent("task-2"));

    expect(wakeCount).toBe(0);
  });

  test("high urgency act-now bypasses hourly budget", async () => {
    const checkpoints = new Map<string, string>();
    checkpoints.set(
      "perception:act-now:hourly-timestamps",
      JSON.stringify([
        Date.parse("2026-05-15T04:20:00.000Z"),
        Date.parse("2026-05-15T04:40:00.000Z"),
      ]),
    );
    let wakeCount = 0;

    const gate = new PerceptionRelevanceGate({
      getProvider: async () =>
        makeProvider(
          JSON.stringify({
            decision: "act-now",
            urgency: "high",
            reason: "Immediate meeting context change.",
          }),
        ),
      now: () => new Date("2026-05-15T05:00:10.000Z"),
      hourlyActNowBudget: 1,
      wakeAgent: async () => {
        wakeCount += 1;
        return { invoked: true, producedToolCalls: false };
      },
      bootstrapConversation: () => ({ id: "conv-3" }),
      getCheckpoint: (key) => checkpoints.get(key) ?? null,
      setCheckpoint: (key, value) => {
        checkpoints.set(key, value);
      },
    });

    await gate.ingest(makeTaskDetectedEvent("task-3"));

    expect(wakeCount).toBe(1);
  });

  test("rolls back budget and cleans conversation when wake is not invoked", async () => {
    const checkpoints = new Map<string, string>();
    const deleted: string[] = [];

    const gate = new PerceptionRelevanceGate({
      getProvider: async () =>
        makeProvider(
          JSON.stringify({
            decision: "act-now",
            urgency: "medium",
          }),
        ),
      now: () => new Date("2026-05-15T05:00:10.000Z"),
      wakeAgent: async () => ({ invoked: false, producedToolCalls: false }),
      bootstrapConversation: () => ({ id: "conv-4" }),
      deleteConversation: (conversationId) => {
        deleted.push(conversationId);
      },
      getCheckpoint: (key) => checkpoints.get(key) ?? null,
      setCheckpoint: (key, value) => {
        checkpoints.set(key, value);
      },
    });

    await gate.ingest(makeTaskDetectedEvent("task-4"));

    expect(deleted).toEqual(["conv-4"]);
    const recorded = checkpoints.get("perception:act-now:hourly-timestamps");
    expect(JSON.parse(recorded ?? "[]")).toHaveLength(0);
  });

  test("publishes relevance_scored event for downstream consumers", async () => {
    const hub = new AssistantEventHub();
    const seen: Array<Record<string, unknown>> = [];
    const sink = hub.subscribe({
      type: "process",
      callback: (event) => {
        const type = (event.message as { type?: string }).type;
        if (type === "perception.relevance_scored") {
          seen.push(event as unknown as Record<string, unknown>);
        }
      },
    });

    const gate = new PerceptionRelevanceGate({
      getProvider: async () =>
        makeProvider(
          JSON.stringify({
            decision: "remember",
            urgency: "low",
            reason: "Useful context to retain.",
          }),
        ),
      now: () => new Date("2026-05-15T05:00:10.000Z"),
    });
    gate.attach(hub);

    await hub.publish(envelope(makeTaskDetectedEvent("task-audit")) as never);

    expect(seen).toHaveLength(1);
    const msg = seen[0]!.message as {
      perception: {
        payload: {
          kind: string;
          decision: string;
          sourceEventId: string;
          triggeredWake: boolean;
          blockedByBudget: boolean;
        };
      };
    };
    expect(msg.perception.payload.kind).toBe("relevance_scored");
    expect(msg.perception.payload.decision).toBe("remember");
    expect(msg.perception.payload.sourceEventId).toBe("task-audit");
    expect(msg.perception.payload.triggeredWake).toBe(false);
    expect(msg.perception.payload.blockedByBudget).toBe(false);

    gate.detach();
    sink.dispose();
  });

  test("redacts sensitive strings in reason and proactive wake hint", async () => {
    const checkpoints = new Map<string, string>();
    const wakeCalls: Array<{ conversationId: string; hint: string }> = [];
    const gate = new PerceptionRelevanceGate({
      getProvider: async () =>
        makeProvider(
          JSON.stringify({
            decision: "act-now",
            urgency: "high",
            reason:
              "User user_abc123 entered https://example.com with apiKey=sk_live_ABCDEF123456",
          }),
        ),
      now: () => new Date("2026-05-15T05:00:10.000Z"),
      wakeAgent: async ({ conversationId, hint }) => {
        wakeCalls.push({ conversationId, hint });
        return { invoked: true, producedToolCalls: false };
      },
      bootstrapConversation: () => ({ id: "conv-9" }),
      getCheckpoint: (key) => checkpoints.get(key) ?? null,
      setCheckpoint: (key, value) => {
        checkpoints.set(key, value);
      },
    });

    await gate.ingest(
      envelope({
        message: {
          type: "perception.task_detected",
          perception: {
            eventId: "task-redact",
            ts: "2026-05-15T05:00:00.000Z",
            source: { module: "skills/perception" },
            payload: {
              kind: "task_detected",
              label: "Account follow-up",
              summary:
                "Investigate token=tok_123456789 and account-12345 at https://internal.example",
              confidence: 0.95,
              sourceEventId: "focus-redact",
            },
          },
        },
      } as ReturnType<typeof makeTaskDetectedEvent>),
    );

    expect(wakeCalls).toHaveLength(1);
    const hint = wakeCalls[0]!.hint;
    expect(hint).toContain("[redacted-url]");
    expect(hint).toContain("[redacted-secret]");
    expect(hint).toContain("[redacted-account-id]");
    expect(hint).not.toContain("tok_123456789");
    expect(hint).not.toContain("account-12345");
  });
});
