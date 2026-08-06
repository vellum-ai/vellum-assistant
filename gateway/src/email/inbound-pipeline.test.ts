/**
 * `runEmailInboundPipeline` is the shared tail for the native Mailgun/Resend
 * webhooks. Trust downgrade of a forged `From:` only works if the pipeline
 * forwards the normalizer's `senderAuthenticated` verdict into `handleInbound`
 * — these tests lock that wiring (the field was previously dropped, making the
 * downgrade a no-op on self-hosted installs).
 *
 * Collaborators are module-mocked so the assertion is purely on the options
 * `handleInbound` receives.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { Logger } from "pino";
import type { GatewayConfig } from "../config.js";
import type { HandleInboundOptions } from "../handlers/handle-inbound.js";
import type { VellumEmailPayload } from "./normalize.js";

let capturedOptions: HandleInboundOptions | undefined;
const handleInboundMock = mock(async (_config, _event, options) => {
  capturedOptions = options as HandleInboundOptions;
  return {
    forwarded: true,
    rejected: false,
    runtimeResponse: { accepted: true, duplicate: false, eventId: "evt-1" },
  };
});

mock.module("../handlers/handle-inbound.js", () => ({
  handleInbound: (...args: unknown[]) =>
    (handleInboundMock as (...a: unknown[]) => unknown)(...args),
}));

mock.module("../routing/resolve-assistant.js", () => ({
  resolveAssistant: () => ({ assistantId: "asst-1", routeSource: "default" }),
  isRejection: () => false,
}));

mock.module("../webhook-pipeline.js", () => ({
  handleCircuitBreakerError: () => undefined,
  processInboundResult: () => ({ ok: true }),
}));

mock.module("./attachments.js", () => ({
  ingestEmailAttachments: async () => ({
    attachmentIds: [],
    failedAttachmentNames: [],
  }),
  appendFailedEmailAttachmentNotice: (content: string) => content,
}));

mock.module("../db/denial-reply-rate-limiter.js", () => ({
  recordDenialReplyIfAllowed: () => true,
}));

const { runEmailInboundPipeline } = await import("./inbound-pipeline.js");
const { StringDedupCache } = await import("../dedup-cache.js");

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLog,
} as unknown as Logger;

function makePayload(
  overrides: Partial<VellumEmailPayload> = {},
): VellumEmailPayload {
  return {
    from: "guardian@example.com",
    to: "bot@example.com",
    subject: "Test",
    bodyText: "hello",
    messageId: "<msg-1@example.com>",
    conversationId: "conv-1",
    ...overrides,
  };
}

async function run(payload: VellumEmailPayload): Promise<void> {
  await runEmailInboundPipeline({
    config: {} as GatewayConfig,
    log: noopLog,
    label: "Mailgun",
    source: "mailgun",
    dedupCache: new StringDedupCache(60_000),
    dedupKey: "",
    vellumPayload: payload,
    traceId: undefined,
    sendReply: undefined,
  });
}

describe("runEmailInboundPipeline sender-authentication threading", () => {
  beforeEach(() => {
    capturedOptions = undefined;
    handleInboundMock.mockClear();
  });

  it("forwards senderAuthenticated=false into handleInbound (forged downgrade)", async () => {
    await run(makePayload({ senderAuthenticated: false }));
    expect(handleInboundMock).toHaveBeenCalledTimes(1);
    expect(capturedOptions?.senderAuthenticated).toBe(false);
  });

  it("forwards senderAuthenticated=true into handleInbound", async () => {
    await run(makePayload({ senderAuthenticated: true }));
    expect(capturedOptions?.senderAuthenticated).toBe(true);
  });

  it("forwards undefined when the payload carries no verdict (no-op)", async () => {
    await run(makePayload());
    expect(capturedOptions?.senderAuthenticated).toBeUndefined();
  });
});
