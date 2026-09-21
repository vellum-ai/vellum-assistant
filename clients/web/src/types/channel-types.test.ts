/**
 * The "this channel is configured" rule, which the channels controller reads
 * for every row's `configured` and the narrow Slack read
 * (`hooks/use-slack-configured.ts`) reads for one channel. Pinned here so a
 * second implementation of it cannot quietly disagree.
 */
import { describe, expect, test } from "bun:test";

import {
  isChannelConfigured,
  type ChannelReadinessSnapshot,
} from "@/types/channel-types";

function snapshot(
  setupStatus: string,
  ready?: boolean,
): ChannelReadinessSnapshot {
  return {
    channel: "slack",
    setupStatus,
    ready,
  } as unknown as ChannelReadinessSnapshot;
}

describe("isChannelConfigured", () => {
  test("is true once setup reports ready", () => {
    expect(isChannelConfigured(snapshot("ready"))).toBe(true);
  });

  test("asks about setup, not delivery: a configured channel can be down", () => {
    expect(isChannelConfigured(snapshot("ready", false))).toBe(true);
  });

  test("is false for setup that got part way or never started", () => {
    expect(isChannelConfigured(snapshot("incomplete"))).toBe(false);
    expect(isChannelConfigured(snapshot("not_configured"))).toBe(false);
  });

  test("is false when the daemon reports nothing for the channel", () => {
    expect(isChannelConfigured(undefined)).toBe(false);
  });
});
