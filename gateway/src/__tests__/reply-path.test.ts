import { describe, test, expect } from "bun:test";
import {
  buildTelegramTransportMetadata,
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
