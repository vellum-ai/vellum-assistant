import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";

import * as daemonSdk from "@/generated/daemon/sdk.gen";
import * as diagnostics from "@/lib/diagnostics";
import * as streamDebug from "@/lib/streaming/stream-debug";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const EVENT = {
  id: "event-1",
  conversationId: "conv-1",
  emittedAt: "2026-07-24T00:00:00.000Z",
  seq: 12,
  message: { type: "assistant_text_delta", content: "hello" },
};

function successResult() {
  return {
    data: { events: [EVENT], complete: true, frontier: 12 },
    response: new Response(null, { status: 200 }),
  };
}

const eventsTailGetSpy = spyOn(daemonSdk, "eventsTailGet");
const ingestReplayedEnvelopesSpy = spyOn(
  streamDebug,
  "ingestReplayedEnvelopes",
);
const recordDiagnosticSpy = spyOn(diagnostics, "recordDiagnostic");

const { ingestServerEventsTail } = await import(
  "@/domains/chat/api/events-tail"
);

beforeEach(() => {
  useAssistantIdentityStore
    .getState()
    .setIdentity("assistant", "0.10.8", "asst-1");
  eventsTailGetSpy.mockClear();
  eventsTailGetSpy.mockImplementation(async () => successResult() as never);
  ingestReplayedEnvelopesSpy.mockClear();
  ingestReplayedEnvelopesSpy.mockImplementation(() => undefined);
  recordDiagnosticSpy.mockClear();
  recordDiagnosticSpy.mockImplementation(() => undefined);
});

afterEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterAll(() => {
  eventsTailGetSpy.mockRestore();
  ingestReplayedEnvelopesSpy.mockRestore();
  recordDiagnosticSpy.mockRestore();
});

describe("ingestServerEventsTail cancellation", () => {
  test("threads the signal and skips replay when the SDK resolves after abort", async () => {
    const controller = new AbortController();
    const deferred: { resolve?: () => void } = {};
    let receivedSignal: AbortSignal | null | undefined;
    eventsTailGetSpy.mockImplementation(
      async (options) =>
        await new Promise<never>((resolve) => {
          receivedSignal = options.signal;
          deferred.resolve = () => resolve(successResult() as never);
        }),
    );

    const request = ingestServerEventsTail(
      "asst-1",
      "conv-1",
      11,
      controller.signal,
    );
    expect(receivedSignal).toBe(controller.signal);
    controller.abort();
    deferred.resolve?.();

    await expect(request).resolves.toBeUndefined();
    expect(ingestReplayedEnvelopesSpy).not.toHaveBeenCalled();
    expect(recordDiagnosticSpy).not.toHaveBeenCalled();
  });

  test("keeps callers without signals and successful replay unchanged", async () => {
    await ingestServerEventsTail("asst-1", "conv-1", 11);

    expect(eventsTailGetSpy.mock.calls[0]?.[0].signal).toBeUndefined();
    expect(ingestReplayedEnvelopesSpy).toHaveBeenCalledWith([EVENT]);
    expect(recordDiagnosticSpy).toHaveBeenCalledWith("events_tail_ingested", {
      conversationId: "conv-1",
      fromSeq: 11,
      count: 1,
      frontier: 12,
    });
  });

  test("still records real fetch failures without rejecting callers", async () => {
    eventsTailGetSpy.mockImplementation(async () => {
      throw new Error("tail unavailable");
    });

    await expect(
      ingestServerEventsTail("asst-1", "conv-1", 11),
    ).resolves.toBeUndefined();

    expect(ingestReplayedEnvelopesSpy).not.toHaveBeenCalled();
    expect(recordDiagnosticSpy).toHaveBeenCalledWith(
      "events_tail_fetch_failed",
      {
        conversationId: "conv-1",
        fromSeq: 11,
        message: "tail unavailable",
      },
    );
  });
});
