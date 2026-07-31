import { afterEach, describe, expect, mock, test } from "bun:test";

let mockEffectiveTimezone = "Europe/Skopje";
mock.module("@/utils/effective-timezone", () => ({
  getEffectiveTimezone: () => mockEffectiveTimezone,
}));

// Controllable stub for the daemon client's POST. Captures the args and
// returns whatever the current test sets up.
let postArgs: unknown = null;
let postImpl: () => Promise<{
  data: unknown;
  response: Response;
}> = async () => ({
  data: null,
  response: new Response(null, { status: 200 }),
});

mock.module("@/generated/daemon/client.gen", () => ({
  client: {
    post: (args: unknown) => {
      postArgs = args;
      return postImpl();
    },
  },
}));

import { streamEmptyStateGreeting } from "@/domains/chat/api/stream-greeting";

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
}

function deltaFrame(text: string): string {
  return `event: btw_text_delta\ndata: ${JSON.stringify({ text })}\n\n`;
}
const COMPLETE_FRAME = "event: btw_complete\ndata: {}\n\n";

afterEach(() => {
  postArgs = null;
  mockEffectiveTimezone = "Europe/Skopje";
});

describe("streamEmptyStateGreeting", () => {
  test("accumulates deltas and resolves with the full greeting", async () => {
    postImpl = async () => ({
      data: sseStream([
        deltaFrame("hey "),
        deltaFrame("there"),
        COMPLETE_FRAME,
      ]),
      response: new Response(null, { status: 200 }),
    });

    const deltas: string[] = [];
    const result = await streamEmptyStateGreeting({
      assistantId: "asst-1",
      onDelta: (text) => deltas.push(text),
    });

    expect(result).toBe("hey there");
    expect(deltas).toEqual(["hey ", "hey there"]);
  });

  test("posts to /btw with the greeting conversation key and a prompt", async () => {
    postImpl = async () => ({
      data: sseStream([deltaFrame("yo"), COMPLETE_FRAME]),
      response: new Response(null, { status: 200 }),
    });

    await streamEmptyStateGreeting({ assistantId: "asst-1" });

    const args = postArgs as {
      url: string;
      path: { assistant_id: string };
      body: { conversationKey: string; content: string };
      parseAs: string;
    };
    expect(args.url).toBe("/v1/assistants/{assistant_id}/btw");
    expect(args.path.assistant_id).toBe("asst-1");
    expect(args.body.conversationKey).toBe("greeting");
    expect(args.body.content.length).toBeGreaterThan(0);
    expect(args.parseAs).toBe("stream");
  });

  test("includes the live effective timezone on the greeting request", async () => {
    mockEffectiveTimezone = "America/New_York";
    postImpl = async () => ({
      data: sseStream([deltaFrame("yo"), COMPLETE_FRAME]),
      response: new Response(null, { status: 200 }),
    });

    await streamEmptyStateGreeting({ assistantId: "asst-1" });

    const args = postArgs as {
      body: { clientTimezone?: string };
    };
    expect(args.body.clientTimezone).toBe("America/New_York");
  });

  test("rejects on a btw_error event", async () => {
    postImpl = async () => ({
      data: sseStream(['event: btw_error\ndata: {"error":"boom"}\n\n']),
      response: new Response(null, { status: 200 }),
    });

    await expect(
      streamEmptyStateGreeting({ assistantId: "asst-1" }),
    ).rejects.toThrow("boom");
  });

  test("rejects on a non-OK response", async () => {
    postImpl = async () => ({
      data: null,
      response: new Response(null, { status: 503 }),
    });

    await expect(
      streamEmptyStateGreeting({ assistantId: "asst-1" }),
    ).rejects.toThrow();
  });

  test("parses an SSE frame split across stream chunks", async () => {
    const full = deltaFrame("split works") + COMPLETE_FRAME;
    const mid = Math.floor(full.length / 2);
    postImpl = async () => ({
      data: sseStream([full.slice(0, mid), full.slice(mid)]),
      response: new Response(null, { status: 200 }),
    });

    const result = await streamEmptyStateGreeting({ assistantId: "asst-1" });
    expect(result).toBe("split works");
  });
});
