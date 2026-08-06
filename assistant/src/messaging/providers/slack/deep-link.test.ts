import { describe, expect, test } from "bun:test";

import {
  buildSlackMessageDeepLinks,
  buildSlackWebChannelUrl,
} from "./deep-link.js";

describe("buildSlackMessageDeepLinks", () => {
  test("builds workspace-branded links when team identity is configured", () => {
    expect(
      buildSlackMessageDeepLinks({
        teamId: "T123",
        teamUrl: "https://example.slack.com",
        channelId: "C123",
        messageTs: "1710000000.000200",
        threadTs: "1710000000.000100",
      }),
    ).toEqual({
      appUrl: "slack://channel?team=T123&id=C123&message=1710000000.000200",
      webUrl:
        "https://example.slack.com/archives/C123/p1710000000000200?thread_ts=1710000000.000100&cid=C123",
    });
  });

  test("falls back to the workspace-agnostic permalink without a teamUrl", () => {
    expect(
      buildSlackMessageDeepLinks({
        teamId: "",
        teamUrl: "",
        channelId: "C123",
        messageTs: "1710000000.000200",
        threadTs: "1710000000.000100",
      }),
    ).toEqual({
      webUrl:
        "https://slack.com/archives/C123/p1710000000000200?thread_ts=1710000000.000100&cid=C123",
    });
  });

  test("fallback permalink omits thread params for a thread root", () => {
    expect(
      buildSlackMessageDeepLinks({
        channelId: "C123",
        messageTs: "1710000000.000100",
        threadTs: "1710000000.000100",
      }),
    ).toEqual({
      webUrl: "https://slack.com/archives/C123/p1710000000000100",
    });
  });

  test("keeps the slack:// app link when only the teamUrl is missing", () => {
    expect(
      buildSlackMessageDeepLinks({
        teamId: "T123",
        channelId: "C123",
        messageTs: "1710000000.000100",
      }),
    ).toEqual({
      appUrl: "slack://channel?team=T123&id=C123&message=1710000000.000100",
      webUrl: "https://slack.com/archives/C123/p1710000000000100",
    });
  });

  test("rejects a non-https teamUrl and falls back to slack.com", () => {
    expect(
      buildSlackMessageDeepLinks({
        teamUrl: "http://example.slack.com",
        channelId: "C123",
        messageTs: "1710000000.000100",
      }).webUrl,
    ).toBe("https://slack.com/archives/C123/p1710000000000100");
  });
});

describe("buildSlackWebChannelUrl", () => {
  test("uses the workspace URL when configured", () => {
    expect(
      buildSlackWebChannelUrl({
        teamUrl: "https://example.slack.com",
        channelId: "C123",
      }),
    ).toBe("https://example.slack.com/archives/C123");
  });

  test("falls back to slack.com without a teamUrl", () => {
    expect(buildSlackWebChannelUrl({ channelId: "C123" })).toBe(
      "https://slack.com/archives/C123",
    );
  });
});
