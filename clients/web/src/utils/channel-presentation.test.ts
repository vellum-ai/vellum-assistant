import { describe, expect, test } from "bun:test";

import {
  getChannelIcon,
  getChannelLabel,
} from "@/utils/channel-presentation";

describe("getChannelLabel", () => {
  test("maps known channel ids to friendly labels", () => {
    expect(getChannelLabel("slack")).toBe("Slack");
    expect(getChannelLabel("telegram")).toBe("Telegram");
    expect(getChannelLabel("whatsapp")).toBe("WhatsApp");
    expect(getChannelLabel("phone")).toBe("Phone");
    expect(getChannelLabel("email")).toBe("Email");
  });

  test("title-cases unknown channel ids", () => {
    expect(getChannelLabel("discord")).toBe("Discord");
    expect(getChannelLabel("signal")).toBe("Signal");
  });

  test("falls back to a generic label when the id is missing", () => {
    expect(getChannelLabel(null)).toBe("channel");
    expect(getChannelLabel(undefined)).toBe("channel");
  });
});

describe("getChannelIcon", () => {
  test("returns a renderable icon for every input, including unknowns", () => {
    expect(getChannelIcon("telegram")).toBeTruthy();
    expect(getChannelIcon("phone")).toBeTruthy();
    expect(getChannelIcon("slack")).toBeTruthy();
  });

  test("distinct channels map to distinct icons", () => {
    expect(getChannelIcon("telegram")).not.toBe(getChannelIcon("phone"));
  });

  test("unknown ids and missing ids share the same fallback icon", () => {
    expect(getChannelIcon("unknown-channel")).toBe(getChannelIcon(null));
  });
});
