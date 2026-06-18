import { describe, expect, it } from "bun:test";
import { isSlackDmChannel } from "./channel.js";

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
