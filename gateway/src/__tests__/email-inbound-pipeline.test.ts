import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Logger } from "pino";
import type { GatewayConfig } from "../config.js";
import { StringDedupCache } from "../dedup-cache.js";
import type { VellumEmailPayload } from "../email/normalize.js";

const handleInboundMock = mock(() =>
  Promise.resolve({ forwarded: true, rejected: false } as Record<
    string,
    unknown
  >),
);
const recordDenialReplyIfAllowedMock = mock(() => true);
const resolveAssistantMock = mock(
  () => ({ assistantId: "assistant-1" }) as Record<string, unknown>,
);

mock.module("../handlers/handle-inbound.js", () => ({
  handleInbound: handleInboundMock,
}));
mock.module("../db/denial-reply-rate-limiter.js", () => ({
  recordDenialReplyIfAllowed: recordDenialReplyIfAllowedMock,
}));
mock.module("../routing/resolve-assistant.js", () => ({
  resolveAssistant: resolveAssistantMock,
  isRejection: (routing: Record<string, unknown>) => "reason" in routing,
}));

const { runEmailInboundPipeline } =
  await import("../email/inbound-pipeline.js");

const silentLog = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
} as unknown as Logger;

const config = {} as GatewayConfig;

const payload: VellumEmailPayload = {
  from: "alice@example.com",
  fromName: "Alice",
  to: "assistant@example.org",
  subject: "Hello",
  bodyText: "Hi there",
  messageId: "<msg-1@example.com>",
  conversationId: "<msg-1@example.com>",
};

function pipelineOpts(
  overrides?: Partial<Parameters<typeof runEmailInboundPipeline>[0]>,
) {
  return {
    config,
    log: silentLog,
    label: "Mailgun",
    source: "mailgun",
    dedupCache: new StringDedupCache(60_000),
    dedupKey: "key-1",
    vellumPayload: payload,
    traceId: undefined,
    sendReply: undefined,
    ...overrides,
  };
}

beforeEach(() => {
  handleInboundMock.mockClear();
  handleInboundMock.mockImplementation(() =>
    Promise.resolve({ forwarded: true, rejected: false }),
  );
  recordDenialReplyIfAllowedMock.mockClear();
  recordDenialReplyIfAllowedMock.mockImplementation(() => true);
  resolveAssistantMock.mockClear();
  resolveAssistantMock.mockImplementation(() => ({
    assistantId: "assistant-1",
  }));
});

describe("runEmailInboundPipeline", () => {
  it("forwards to the runtime and marks the dedup key", async () => {
    const dedupCache = new StringDedupCache(60_000);
    dedupCache.reserve("key-1");
    const response = await runEmailInboundPipeline(
      pipelineOpts({ dedupCache }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(handleInboundMock).toHaveBeenCalledTimes(1);
    const forwardOptions = (
      handleInboundMock.mock.calls[0] as unknown[]
    )[2] as {
      sourceMetadata: Record<string, unknown>;
    };
    expect(forwardOptions.sourceMetadata.emailProvider).toBe("mailgun");
    // A marked key stays deduped: a second reserve is refused
    expect(dedupCache.reserve("key-1")).toBe(false);
  });

  it("acknowledges without forwarding when routing rejects", async () => {
    resolveAssistantMock.mockImplementation(() => ({ reason: "no-route" }));
    const response = await runEmailInboundPipeline(pipelineOpts());
    expect(response.status).toBe(200);
    expect(handleInboundMock).not.toHaveBeenCalled();
  });

  it("sends a verification reply and short-circuits", async () => {
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({
        forwarded: false,
        rejected: false,
        verificationIntercepted: true,
        verificationReplyText: "You are verified",
      }),
    );
    const sent: Array<Record<string, unknown>> = [];
    const response = await runEmailInboundPipeline(
      pipelineOpts({
        sendReply: async (args) => {
          sent.push(args);
        },
      }),
    );
    expect(await response.json()).toEqual({
      ok: true,
      verificationIntercepted: true,
    });
    expect(sent).toEqual([
      {
        kind: "verification",
        from: "assistant@example.org",
        to: "alice@example.com",
        subject: "Re: Hello",
        text: "You are verified",
        inReplyTo: "<msg-1@example.com>",
      },
    ]);
    // Verification replies are never gated by the denial rate limiter
    expect(recordDenialReplyIfAllowedMock).not.toHaveBeenCalled();
  });

  it("sends a rate-limited denial reply when the runtime denies", async () => {
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({
        forwarded: true,
        rejected: false,
        runtimeResponse: { denied: true, replyText: "Not allowed" },
      }),
    );
    const sent: Array<Record<string, unknown>> = [];
    const response = await runEmailInboundPipeline(
      pipelineOpts({
        sendReply: async (args) => {
          sent.push(args);
        },
      }),
    );
    expect(await response.json()).toEqual({
      ok: true,
      denied: true,
      replyText: "Not allowed",
    });
    expect(recordDenialReplyIfAllowedMock).toHaveBeenCalledWith(
      "email",
      "alice@example.com",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("denial");
  });

  it("skips the denial reply when the rate limiter refuses", async () => {
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({
        forwarded: true,
        rejected: false,
        runtimeResponse: { denied: true, replyText: "Not allowed" },
      }),
    );
    recordDenialReplyIfAllowedMock.mockImplementation(() => false);
    const sent: Array<Record<string, unknown>> = [];
    const response = await runEmailInboundPipeline(
      pipelineOpts({
        sendReply: async (args) => {
          sent.push(args);
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it("skips replies entirely without a sendReply sender", async () => {
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({
        forwarded: true,
        rejected: false,
        runtimeResponse: { denied: true, replyText: "Not allowed" },
      }),
    );
    const response = await runEmailInboundPipeline(pipelineOpts());
    expect(response.status).toBe(200);
    expect(recordDenialReplyIfAllowedMock).not.toHaveBeenCalled();
  });

  it("returns 500 and unreserves the dedup key on forwarding failure", async () => {
    handleInboundMock.mockImplementation(() =>
      Promise.resolve({ forwarded: false, rejected: false }),
    );
    const dedupCache = new StringDedupCache(60_000);
    dedupCache.reserve("key-1");
    const response = await runEmailInboundPipeline(
      pipelineOpts({ dedupCache }),
    );
    expect(response.status).toBe(500);
    // Unreserved: the key can be reserved again for the retry delivery
    expect(dedupCache.reserve("key-1")).toBe(true);
  });
});
