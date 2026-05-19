import { describe, expect, test } from "bun:test";

import type { Provider } from "../providers/types.js";
import { AssistantEventHub } from "../runtime/assistant-event-hub.js";
import { PerceptionInterpreter } from "./interpreter.js";

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

function appFocusMessage() {
  return {
    type: "perception.app_focus_changed",
    perception: {
      eventId: "focus-1",
      ts: "2026-05-15T04:00:00.000Z",
      source: { module: "skills/perception" },
      payload: {
        kind: "app_focus_changed",
        appId: "com.microsoft.VSCode",
        appName: "Visual Studio Code",
        windowTitle: "Debug user@example.com in https://example.com",
        redacted: false,
      },
    },
  };
}

describe("PerceptionInterpreter", () => {
  test("publishes task_detected for high-confidence app focus interpretation", async () => {
    const hub = new AssistantEventHub();
    const seen: Array<Record<string, unknown>> = [];
    const sink = hub.subscribe({
      type: "process",
      callback: (event) => {
        const type = (event.message as { type?: string }).type;
        if (type === "perception.task_detected") {
          seen.push(event as unknown as Record<string, unknown>);
        }
      },
    });

    const interpreter = new PerceptionInterpreter({
      getProvider: async () =>
        makeProvider(
          JSON.stringify({
            emit: true,
            label: "Debugging API auth issue",
            summary:
              "User is debugging user@example.com while testing https://example.com",
            confidence: 0.92,
          }),
        ),
      now: () => new Date("2026-05-15T04:00:05.000Z"),
    });
    interpreter.attach(hub);

    await hub.publish({
      id: "in-1",
      emittedAt: "2026-05-15T04:00:00.000Z",
      message: appFocusMessage(),
    } as never);

    expect(seen).toHaveLength(1);
    const message = (seen[0] as { message: Record<string, unknown> }).message;
    const perception = message.perception as {
      payload: {
        kind: string;
        label: string;
        summary: string;
        confidence: number;
      };
    };
    expect(perception.payload.kind).toBe("task_detected");
    expect(perception.payload.label).toBe("Debugging API auth issue");
    expect(perception.payload.summary).toContain("[redacted-email]");
    expect(perception.payload.summary).toContain("[redacted-url]");
    expect(perception.payload.confidence).toBe(0.92);

    interpreter.detach();
    sink.dispose();
  });

  test("does not publish when interpreter decides emit=false", async () => {
    const hub = new AssistantEventHub();
    let count = 0;
    const sink = hub.subscribe({
      type: "process",
      callback: (event) => {
        const type = (event.message as { type?: string }).type;
        if (type === "perception.task_detected") count += 1;
      },
    });
    const interpreter = new PerceptionInterpreter({
      getProvider: async () => makeProvider(JSON.stringify({ emit: false })),
    });
    interpreter.attach(hub);

    await hub.publish({
      id: "in-2",
      emittedAt: "2026-05-15T04:00:00.000Z",
      message: appFocusMessage(),
    } as never);

    expect(count).toBe(0);
    interpreter.detach();
    sink.dispose();
  });

  test("publishes meeting_started with normalized platform", async () => {
    const hub = new AssistantEventHub();
    const seenTypes: string[] = [];
    const sink = hub.subscribe({
      type: "process",
      callback: (event) => {
        const type = (event.message as { type?: string }).type;
        if (typeof type === "string" && type.startsWith("perception.")) {
          seenTypes.push(type);
        }
      },
    });
    const interpreter = new PerceptionInterpreter({
      getProvider: async () =>
        makeProvider(
          JSON.stringify({
            emit: true,
            kind: "meeting_started",
            summary: "Joined standup at https://meet.google.com/xyz",
            confidence: 0.88,
            platform: "google-meet",
          }),
        ),
    });
    interpreter.attach(hub);

    await hub.publish({
      id: "in-3",
      emittedAt: "2026-05-15T04:00:00.000Z",
      message: appFocusMessage(),
    } as never);

    expect(seenTypes).toContain("perception.meeting_started");
    interpreter.detach();
    sink.dispose();
  });

  test("drops low-confidence interpretation", async () => {
    const hub = new AssistantEventHub();
    let emitted = false;
    const sink = hub.subscribe({
      type: "process",
      callback: (event) => {
        const type = (event.message as { type?: string }).type;
        if (type === "perception.code_edited") emitted = true;
      },
    });
    const interpreter = new PerceptionInterpreter({
      getProvider: async () =>
        makeProvider(
          JSON.stringify({
            emit: true,
            kind: "code_edited",
            summary: "Editing TypeScript files in Eli",
            confidence: 0.2,
          }),
        ),
      minConfidence: 0.5,
    });
    interpreter.attach(hub);

    await hub.publish({
      id: "in-4",
      emittedAt: "2026-05-15T04:00:00.000Z",
      message: appFocusMessage(),
    } as never);

    expect(emitted).toBe(false);
    interpreter.detach();
    sink.dispose();
  });

  test("redacts token-like and account-id-like strings from interpreted output", async () => {
    const hub = new AssistantEventHub();
    const seen: Array<Record<string, unknown>> = [];
    const sink = hub.subscribe({
      type: "process",
      callback: (event) => {
        const type = (event.message as { type?: string }).type;
        if (type === "perception.task_detected") {
          seen.push(event as unknown as Record<string, unknown>);
        }
      },
    });

    const interpreter = new PerceptionInterpreter({
      getProvider: async () =>
        makeProvider(
          JSON.stringify({
            emit: true,
            label: "Investigate tokenabc123456",
            summary:
              "Check apiKey=sk_live_ABCDEF123456 for account-12345 and user_67890",
            confidence: 0.9,
          }),
        ),
      now: () => new Date("2026-05-15T04:00:05.000Z"),
    });
    interpreter.attach(hub);

    await hub.publish({
      id: "in-5",
      emittedAt: "2026-05-15T04:00:00.000Z",
      message: appFocusMessage(),
    } as never);

    expect(seen).toHaveLength(1);
    const message = (seen[0] as { message: Record<string, unknown> }).message;
    const perception = message.perception as {
      payload: { label: string; summary: string };
    };
    expect(perception.payload.label).toContain("[redacted-secret]");
    expect(perception.payload.summary).toContain("[redacted-secret]");
    expect(perception.payload.summary).toContain("[redacted-account-id]");
    expect(perception.payload.summary).not.toContain("sk_live_ABCDEF123456");

    interpreter.detach();
    sink.dispose();
  });

  test("debounces rapid duplicate app focus signals", async () => {
    const hub = new AssistantEventHub();
    let providerCalls = 0;
    let nowMs = Date.parse("2026-05-15T04:00:00.000Z");

    const interpreter = new PerceptionInterpreter({
      getProvider: async () => ({
        name: "test-provider",
        async sendMessage() {
          providerCalls += 1;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  emit: true,
                  label: "Coding",
                  summary: "Editing code",
                  confidence: 0.9,
                }),
              },
            ],
            model: "test-model",
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "stop",
          };
        },
      }),
      now: () => new Date(nowMs),
      debounceMs: 2_000,
    });
    interpreter.attach(hub);

    await hub.publish({
      id: "in-6",
      emittedAt: new Date(nowMs).toISOString(),
      message: appFocusMessage(),
    } as never);

    nowMs += 500; // within debounce window
    await hub.publish({
      id: "in-7",
      emittedAt: new Date(nowMs).toISOString(),
      message: appFocusMessage(),
    } as never);

    nowMs += 3_000; // outside debounce window
    await hub.publish({
      id: "in-8",
      emittedAt: new Date(nowMs).toISOString(),
      message: appFocusMessage(),
    } as never);

    expect(providerCalls).toBe(2);
    interpreter.detach();
  });
});
