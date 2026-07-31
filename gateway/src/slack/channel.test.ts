import { describe, expect, it } from "bun:test";
import { isSlackDmChannel, isSlackMpimChannel } from "./channel.js";

describe("isSlackDmChannel", () => {
  it("classifies an explicit im channel_type as a DM", () => {
    expect(isSlackDmChannel("C0123ABCD", "im")).toBe(true);
    expect(isSlackDmChannel("D0123ABCD", "im")).toBe(true);
  });

  it("classifies a D-prefixed conversation ID as a DM even without channel_type", () => {
    expect(isSlackDmChannel("D0123ABCD")).toBe(true);
    expect(isSlackDmChannel("D0123ABCD", undefined)).toBe(true);
  });

  it("does not classify channels or private groups as DMs", () => {
    expect(isSlackDmChannel("C0123ABCD")).toBe(false);
    expect(isSlackDmChannel("G0123ABCD", "mpim")).toBe(false);
    expect(isSlackDmChannel("C0123ABCD", "channel")).toBe(false);
  });

  it("is not a DM when neither signal identifies one", () => {
    expect(isSlackDmChannel(undefined)).toBe(false);
    expect(isSlackDmChannel("")).toBe(false);
  });
});

describe("isSlackMpimChannel", () => {
  it("classifies an explicit mpim channel_type as a group DM", () => {
    expect(isSlackMpimChannel("mpim")).toBe(true);
  });

  it("does not classify other conversation kinds as group DMs", () => {
    expect(isSlackMpimChannel("im")).toBe(false);
    expect(isSlackMpimChannel("channel")).toBe(false);
    expect(isSlackMpimChannel("group")).toBe(false);
  });

  it("has no id-prefix fallback in either direction", () => {
    // `G` is shared with private channels, and modern workspaces mint MPIMs
    // with a plain `C` prefix, confirmed against `conversations.info`
    // (`is_mpim: true, is_channel: true`). An id alone proves nothing, so
    // payloads without a channel_type resolve through the observed-kind cache
    // instead (see user-directory.ts).
    expect(isSlackMpimChannel(undefined)).toBe(false);
    expect(isSlackMpimChannel("")).toBe(false);
  });
});
