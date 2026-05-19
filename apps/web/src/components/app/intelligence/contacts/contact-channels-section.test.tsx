import { describe, expect, test } from "bun:test";

import type { ChannelInfo, ContactChannelPayload } from "@/lib/contacts/types.js";

import {
  buildVisibleChannels,
  getChannelActionState,
} from "@/components/app/intelligence/contacts/contact-channels-section.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeChannelInfo(overrides: Partial<ChannelInfo> & { id: string }): ChannelInfo {
  return {
    label: overrides.id.charAt(0).toUpperCase() + overrides.id.slice(1),
    subtitle: "",
    icon: "help-circle",
    supportsVerification: false,
    setupMessages: { guardian: "", contact: "" },
    ...overrides,
  };
}

function makeContactChannel(
  overrides: Partial<ContactChannelPayload> & { type: string },
): ContactChannelPayload {
  return {
    id: `ch-${overrides.type}`,
    address: "",
    isPrimary: false,
    status: "active",
    policy: "default",
    ...overrides,
  };
}

const slackInfo = makeChannelInfo({
  id: "slack",
  icon: "hash",
  supportsVerification: true,
});
const emailInfo = makeChannelInfo({ id: "email", icon: "mail" });
const whatsappInfo = makeChannelInfo({ id: "whatsapp", icon: "message-square" });
const a2aInfo = makeChannelInfo({ id: "a2a", icon: "bot", label: "A2A" });

// ---------------------------------------------------------------------------
// buildVisibleChannels
// ---------------------------------------------------------------------------

describe("buildVisibleChannels", () => {
  test("includes A2A when a2aEnabled is true", () => {
    const result = buildVisibleChannels([slackInfo, a2aInfo], [], true);
    expect(result.some((ch) => ch.id === "a2a")).toBe(true);
  });

  test("excludes A2A when a2aEnabled is false", () => {
    const result = buildVisibleChannels([slackInfo, a2aInfo], [], false);
    expect(result.some((ch) => ch.id === "a2a")).toBe(false);
  });

  test("excludes synthesized A2A fallback rows when a2aEnabled is false", () => {
    const a2aContactChannel = makeContactChannel({ type: "a2a" });
    const result = buildVisibleChannels([], [a2aContactChannel], false);
    expect(result.some((ch) => ch.id === "a2a")).toBe(false);
  });

  test("non-A2A channels always included regardless of a2aEnabled", () => {
    const result = buildVisibleChannels(
      [slackInfo, emailInfo, a2aInfo],
      [],
      false,
    );
    expect(result.map((ch) => ch.id)).toEqual(["slack", "email"]);
  });

  test("includes synthesized fallback rows for non-A2A contact channels", () => {
    const telegramChannel = makeContactChannel({ type: "telegram" });
    const result = buildVisibleChannels([slackInfo], [telegramChannel], false);
    expect(result.map((ch) => ch.id)).toEqual(["slack", "telegram"]);
  });

  test("excludes A2A from available channels when a2aEnabled is undefined", () => {
    const result = buildVisibleChannels([slackInfo, a2aInfo], []);
    expect(result.some((ch) => ch.id === "a2a")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getChannelActionState
// ---------------------------------------------------------------------------

describe("getChannelActionState", () => {
  test("A2A channel with active status returns connected", () => {
    const existing = makeContactChannel({ type: "a2a", status: "active" });
    const result = getChannelActionState(a2aInfo, existing);
    expect(result).toEqual({ kind: "connected" });
  });

  test("A2A channel with no existing entry returns setup", () => {
    const result = getChannelActionState(a2aInfo, undefined);
    expect(result).toEqual({ kind: "setup" });
  });

  test("A2A channel with revoked status returns setup", () => {
    const existing = makeContactChannel({ type: "a2a", status: "revoked" });
    const result = getChannelActionState(a2aInfo, existing);
    expect(result).toEqual({ kind: "setup" });
  });

  test("Slack channel with verified status returns verified", () => {
    const existing = makeContactChannel({
      type: "slack",
      status: "verified",
    });
    const result = getChannelActionState(slackInfo, existing);
    expect(result).toEqual({ kind: "verified" });
  });

  test("Slack channel with active status and verifiedAt returns verified", () => {
    const existing = makeContactChannel({
      type: "slack",
      status: "active",
      verifiedAt: Date.now(),
    });
    const result = getChannelActionState(slackInfo, existing);
    expect(result).toEqual({ kind: "verified" });
  });

  test("Slack channel with active status and no verifiedAt returns unverified", () => {
    const existing = makeContactChannel({
      type: "slack",
      status: "active",
      verifiedAt: null,
    });
    const result = getChannelActionState(slackInfo, existing);
    expect(result).toEqual({ kind: "unverified" });
  });

  test("Email channel (supportsVerification: false) with active status returns unverified, not connected", () => {
    const existing = makeContactChannel({
      type: "email",
      status: "active",
      verifiedAt: null,
    });
    const result = getChannelActionState(emailInfo, existing);
    // Email is not A2A, so it follows the standard path — unverified
    expect(result).toEqual({ kind: "unverified" });
  });

  test("WhatsApp channel (supportsVerification: false) with active status is unaffected", () => {
    const existing = makeContactChannel({
      type: "whatsapp",
      status: "active",
      verifiedAt: null,
    });
    const result = getChannelActionState(whatsappInfo, existing);
    expect(result).toEqual({ kind: "unverified" });
  });

  test("channel with no existing entry returns setup", () => {
    const result = getChannelActionState(slackInfo, undefined);
    expect(result).toEqual({ kind: "setup" });
  });

  test("channel with revoked status returns setup", () => {
    const existing = makeContactChannel({
      type: "slack",
      status: "revoked",
    });
    const result = getChannelActionState(slackInfo, existing);
    expect(result).toEqual({ kind: "setup" });
  });
});
