import { describe, test, expect } from "bun:test";
import {
  buildEmailTransportMetadata,
  buildTelegramTransportMetadata,
  EMAIL_CHANNEL_TRANSPORT_HINTS,
  EMAIL_CHANNEL_TRANSPORT_UX_BRIEF,
  EMAIL_REPLY_VIA_CLI_HINT,
  TELEGRAM_CHANNEL_TRANSPORT_HINTS,
  TELEGRAM_CHANNEL_TRANSPORT_UX_BRIEF,
} from "../channels/transport-hints.js";
import { splitText } from "../util/split-text.js";

describe("splitText", () => {
  const MAX_LEN = 4000;

  test("returns single chunk for short text", () => {
    const chunks = splitText("Hello!", MAX_LEN);
    expect(chunks).toEqual(["Hello!"]);
  });

  test("returns single chunk for exactly max length", () => {
    const text = "x".repeat(MAX_LEN);
    const chunks = splitText(text, MAX_LEN);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  test("splits text exceeding max length", () => {
    const text = "x".repeat(8500);
    const chunks = splitText(text, MAX_LEN);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(4000);
    expect(chunks[1]).toHaveLength(4000);
    expect(chunks[2]).toHaveLength(500);
    expect(chunks.join("")).toBe(text);
  });

  test("handles empty string", () => {
    const chunks = splitText("", MAX_LEN);
    expect(chunks).toEqual([""]);
  });
});

describe("telegram onboarding transport metadata", () => {
  test("publishes deterministic channel-safe hints", () => {
    const metadata = buildTelegramTransportMetadata();
    expect(metadata.hints).toEqual([...TELEGRAM_CHANNEL_TRANSPORT_HINTS]);
    expect(metadata.hints).toContain("defer-dashboard-only-tasks");
  });

  test("publishes explicit dashboard deferral UX brief", () => {
    const metadata = buildTelegramTransportMetadata();
    expect(metadata.uxBrief).toBe(TELEGRAM_CHANNEL_TRANSPORT_UX_BRIEF);
    expect(metadata.uxBrief.toLowerCase()).toContain("defer");
    expect(metadata.uxBrief.toLowerCase()).toContain("dashboard");
  });
});

describe("email inbound transport metadata", () => {
  test("always steers replies through the email send CLI", () => {
    const metadata = buildEmailTransportMetadata();
    expect(metadata.hints).toEqual([
      ...EMAIL_CHANNEL_TRANSPORT_HINTS,
      EMAIL_REPLY_VIA_CLI_HINT,
    ]);
    expect(metadata.hints).toContain("email-reply-via-cli");
    expect(metadata.hints).toContain(EMAIL_REPLY_VIA_CLI_HINT);
    expect(metadata.uxBrief).toBe(EMAIL_CHANNEL_TRANSPORT_UX_BRIEF);
    expect(metadata.uxBrief).toContain("assistant email send");
    expect(metadata.uxBrief).toContain("Conversation text is not emailed");
  });

  test("adds sender context and the CLI reply hint for an inbound message", () => {
    const metadata = buildEmailTransportMetadata({
      senderAddress: "alice@example.com",
      recipientAddress: "assistant@example.com",
      subject: "Reply when you can",
      inReplyTo: "msg-123",
    });

    expect(metadata.hints).toContain("email-sender: alice@example.com");
    expect(metadata.hints).toContain("email-recipient: assistant@example.com");
    expect(metadata.hints).toContain("email-subject: Reply when you can");
    expect(metadata.hints).toContain("email-in-reply-to: msg-123");
    expect(metadata.hints).toContain(EMAIL_REPLY_VIA_CLI_HINT);
    expect(metadata.hints.join("\n")).toContain("assistant email send");
    expect(metadata.hints.join("\n")).not.toContain("email-reply-help:");
  });
});
