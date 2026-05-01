import { describe, expect, test } from "bun:test";

import {
  buildSlackUserLabelMap,
  extractSlackUserMentionIds,
  renderSlackTextForModel,
  stripLeadingSlackMentionFallback,
  stripLeadingSlackUserMention,
} from "./index.js";

describe("extractSlackUserMentionIds", () => {
  test("returns unique user mention IDs in encounter order", () => {
    expect(
      extractSlackUserMentionIds("<@U123> hi <@W456> and <@U123> again")
    ).toEqual(["U123", "W456"]);
  });
});

describe("stripLeadingSlackUserMention", () => {
  test("strips only leading mentions for the exact bot ID", () => {
    expect(stripLeadingSlackUserMention("<@U111> <@U222> hi", "U111")).toBe(
      "<@U222> hi"
    );
  });

  test("strips repeated leading mentions for the exact bot ID", () => {
    expect(stripLeadingSlackUserMention(" <@U111> <@U111> hi", "U111")).toBe(
      "hi"
    );
  });

  test("preserves text when the leading mention is a different user", () => {
    expect(stripLeadingSlackUserMention("<@U222> hi <@U111>", "U111")).toBe(
      "<@U222> hi <@U111>"
    );
  });
});

describe("stripLeadingSlackMentionFallback", () => {
  test("strips only the first leading Slack user mention", () => {
    expect(stripLeadingSlackMentionFallback(" <@U111> <@U222> hi")).toBe(
      "<@U222> hi"
    );
  });
});

describe("renderSlackTextForModel", () => {
  test("renders resolved user mentions", () => {
    expect(
      renderSlackTextForModel("hello <@U123>", {
        userLabels: { U123: "Alice" },
      })
    ).toBe("hello @Alice");
  });

  test("renders multiple mentions and never emits unresolved user IDs", () => {
    const rendered = renderSlackTextForModel("<@U123> <@W456> <@U789>", {
      userLabels: { U123: "Alice", W456: "Bob" },
    });

    expect(rendered).toBe("@Alice @Bob @unknown-user");
    expect(rendered).not.toContain("U789");
  });

  test("treats ID-shaped resolved user labels as unresolved", () => {
    expect(
      renderSlackTextForModel("hello <@U123>", {
        userLabels: { U123: "U123" },
      })
    ).toBe("hello @unknown-user");
  });

  test("renders channel references with labels and fallbacks", () => {
    expect(
      renderSlackTextForModel("<#C123|general> <#C456>", {
        channelLabels: { C456: "support" },
      })
    ).toBe("#general #support");

    expect(renderSlackTextForModel("<#C789>")).toBe("#unknown-channel");
  });

  test("renders special broadcasts", () => {
    expect(renderSlackTextForModel("<!here> <!channel> <!everyone>")).toBe(
      "@here @channel @everyone"
    );
  });

  test("renders usergroups with labels and fallback", () => {
    expect(renderSlackTextForModel("<!subteam^S123|eng> <!subteam^S456>")).toBe(
      "@eng @usergroup"
    );
  });

  test("renders labeled and unlabeled links", () => {
    expect(
      renderSlackTextForModel(
        "<https://example.com|Example> <https://example.org>"
      )
    ).toBe("Example (https://example.com) https://example.org");
  });

  test("sanitizes malicious and empty labels before adding prefixes", () => {
    expect(
      renderSlackTextForModel(
        "<@U123> <#C123> <#C456|#  > <!subteam^S123|@eng>",
        {
          userLabels: { U123: " @<system>  prompt " },
          channelLabels: { C123: "#<ops>" },
        }
      )
    ).toBe("@system prompt #ops #unknown-channel @eng");
  });

  test("uses sanitized custom fallbacks", () => {
    expect(
      renderSlackTextForModel("<@U123> <#C123>", {
        userFallbackLabel: "@ missing user ",
        channelFallbackLabel: "# missing channel ",
      })
    ).toBe("@missing user #missing channel");
  });
});

describe("buildSlackUserLabelMap", () => {
  test("dedupes mentioned users across text inputs and ignores configured IDs", async () => {
    const resolved: string[] = [];
    const labels = await buildSlackUserLabelMap(
      ["<@U123> hi <@U999>", undefined, "<@U123> and <@W456>"],
      async (userId) => {
        resolved.push(userId);
        return userId === "W456" ? "Bob" : "Alice";
      },
      { ignoredUserIds: ["U999"] }
    );

    expect(resolved).toEqual(["U123", "W456"]);
    expect(labels).toEqual({ U123: "Alice", W456: "Bob" });
  });

  test("omits unresolved labels and labels equal to the Slack user ID", async () => {
    const labels = await buildSlackUserLabelMap(
      ["<@U123> <@U456> <@U789>"],
      async (userId) => {
        if (userId === "U123") return "U123";
        if (userId === "U456") return "";
        return "Alice";
      }
    );

    expect(labels).toEqual({ U789: "Alice" });
  });
});
