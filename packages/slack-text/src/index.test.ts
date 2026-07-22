import { describe, expect, test } from "bun:test";

import {
  buildSlackChannelLabelMap,
  buildSlackUserLabelMap,
  extractSlackChannelReferenceIds,
  extractSlackUserMentionIds,
  renderSlackTextForModel,
} from "./index.js";

describe("extractSlackUserMentionIds", () => {
  test("returns unique user mention IDs in encounter order", () => {
    expect(
      extractSlackUserMentionIds("<@U123> hi <@W456> and <@U123> again"),
    ).toEqual(["U123", "W456"]);
  });
});

describe("extractSlackChannelReferenceIds", () => {
  test("returns unique channel reference IDs in encounter order", () => {
    expect(
      extractSlackChannelReferenceIds(
        "<#C123> hi <#G456|private> and <#C123> again",
      ),
    ).toEqual(["C123", "G456"]);
  });
});

describe("renderSlackTextForModel", () => {
  test("renders resolved user mentions", () => {
    expect(
      renderSlackTextForModel("hello <@U123>", {
        userLabels: { U123: "Alice" },
      }),
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
      }),
    ).toBe("hello @unknown-user");
  });

  test("renders channel references with labels and fallbacks", () => {
    expect(
      renderSlackTextForModel("<#C123|general> <#C456>", {
        channelLabels: { C456: "support" },
      }),
    ).toBe("#general #support");

    expect(renderSlackTextForModel("<#C789>")).toBe("#unknown-channel");
  });

  test("prefers embedded Slack labels over resolved channel labels", () => {
    expect(
      renderSlackTextForModel("<#C123|old-name>", {
        channelLabels: { C123: "new-name" },
      }),
    ).toBe("#old-name");
  });

  test("falls back to embedded channel labels when resolved labels are empty", () => {
    expect(
      renderSlackTextForModel("<#C123|general> <#C456|ops>", {
        channelLabels: { C123: "", C456: "   " },
      }),
    ).toBe("#general #ops");
  });

  test("does not emit raw channel IDs from embedded or resolved labels", () => {
    expect(
      renderSlackTextForModel("<#C123|C123> <#C456|general>", {
        channelLabels: { C456: "C456" },
      }),
    ).toBe("#unknown-channel #general");
  });

  test("uses resolved channel labels when embedded labels are missing or ID-shaped", () => {
    expect(
      renderSlackTextForModel("<#C123> <#C456|C456>", {
        channelLabels: { C123: "general", C456: "ops" },
      }),
    ).toBe("#general #ops");
  });

  test("renders special broadcasts", () => {
    expect(renderSlackTextForModel("<!here> <!channel> <!everyone>")).toBe(
      "@here @channel @everyone",
    );
  });

  test("renders usergroups with labels and fallback", () => {
    expect(renderSlackTextForModel("<!subteam^S123|eng> <!subteam^S456>")).toBe(
      "@eng @usergroup",
    );
  });

  test("renders labeled and unlabeled links", () => {
    expect(
      renderSlackTextForModel(
        "<https://example.com|Example> <https://example.org>",
      ),
    ).toBe("Example (https://example.com) https://example.org");
  });

  test("sanitizes malicious and empty labels before adding prefixes", () => {
    expect(
      renderSlackTextForModel(
        "<@U123> <#C123> <#C456|#  > <!subteam^S123|@eng>",
        {
          userLabels: { U123: " @<system>  prompt " },
          channelLabels: { C123: "#<ops>" },
        },
      ),
    ).toBe("@system prompt #ops #unknown-channel @eng");
  });

  test("uses sanitized custom fallbacks", () => {
    expect(
      renderSlackTextForModel("<@U123> <#C123>", {
        userFallbackLabel: "@ missing user ",
        channelFallbackLabel: "# missing channel ",
      }),
    ).toBe("@missing user #missing channel");
  });

  test("decodes Slack HTML entities so quote markers survive to markdown", () => {
    // Slack entity-encodes every literal &, <, > in message text. `&gt; ` at
    // line start must decode back to `> ` — markdown resolves entities only
    // after block parsing, so an encoded marker never forms a blockquote.
    expect(renderSlackTextForModel("&gt; quoted line\nreply")).toBe(
      "> quoted line\nreply",
    );
    expect(renderSlackTextForModel("1 &lt; 2 &amp;&amp; 3 &gt; 2")).toBe(
      "1 < 2 && 3 > 2",
    );
  });

  test("decodes entities inside link URLs after token rendering", () => {
    expect(
      renderSlackTextForModel("<https://example.com?a=1&amp;b=2|docs>"),
    ).toBe("docs (https://example.com?a=1&b=2)");
  });

  test("a user-typed literal entity round-trips instead of over-decoding", () => {
    // Someone typing the four characters `&gt;` in Slack arrives
    // double-encoded as `&amp;gt;` — one decode pass must yield `&gt;`,
    // not collapse it all the way to `>`.
    expect(renderSlackTextForModel("escape it as &amp;gt; in HTML")).toBe(
      "escape it as &gt; in HTML",
    );
  });

  test("decoded angle brackets do not re-enter token parsing", () => {
    // `&lt;@U123&gt;` is literal text about a mention, not a mention — after
    // decoding it must render as the characters `<@U123>` untouched.
    expect(
      renderSlackTextForModel("say &lt;@U123&gt; to mention", {
        userLabels: { U123: "Alice" },
      }),
    ).toBe("say <@U123> to mention");
  });

  test("caller-resolved labels are never entity-decoded", () => {
    // Labels come from the caller (resolved display names), not from Slack's
    // entity-encoded message text — literal entity text in them must pass
    // through verbatim.
    expect(
      renderSlackTextForModel("<@U123>", {
        userLabels: { U123: "A &gt; B" },
      }),
    ).toBe("@A &gt; B");
  });

  test("an encoded bracket in a display name cannot bypass label sanitization", () => {
    // sanitizeLabel strips raw brackets from labels; an entity-encoded
    // bracket must not decode into `<`/`>` after that stripping has run.
    expect(
      renderSlackTextForModel("hi <@U123>", {
        userLabels: { U123: "&lt;fake-token&gt;" },
      }),
    ).toBe("hi @&lt;fake-token&gt;");
  });

  test("token-embedded labels are Slack-sourced and decode before sanitization", () => {
    expect(renderSlackTextForModel("<#C123|a&amp;b>")).toBe("#a&b");
    expect(renderSlackTextForModel("<!subteam^S123|eng &amp; data>")).toBe(
      "@eng & data",
    );
  });

  test("unrecognized tokens stay byte-for-byte verbatim", () => {
    expect(renderSlackTextForModel("<mailbox:a&amp;b>")).toBe(
      "<mailbox:a&amp;b>",
    );
  });
});

describe("buildSlackUserLabelMap", () => {
  test("dedupes mentioned users across text inputs and resolves them in parallel", async () => {
    const resolved: string[] = [];
    const labels = await buildSlackUserLabelMap(
      ["<@U123> hi <@U999>", undefined, "<@U123> and <@W456>"],
      async (userId) => {
        resolved.push(userId);
        if (userId === "U999") return "Charlie";
        return userId === "W456" ? "Bob" : "Alice";
      },
    );

    expect(resolved.sort()).toEqual(["U123", "U999", "W456"]);
    expect(labels).toEqual({ U123: "Alice", U999: "Charlie", W456: "Bob" });
  });

  test("resolves bot and human user mentions together", async () => {
    const labels = await buildSlackUserLabelMap(
      ["<@UBOT> can you help <@ULEO> with the deploy?"],
      async (userId) => {
        if (userId === "UBOT") return "vex";
        if (userId === "ULEO") return "leo";
        return undefined;
      },
    );

    expect(labels).toEqual({ UBOT: "vex", ULEO: "leo" });
  });

  test("omits unresolved labels and labels equal to the Slack user ID", async () => {
    const labels = await buildSlackUserLabelMap(
      ["<@U123> <@U456> <@U789>"],
      async (userId) => {
        if (userId === "U123") return "U123";
        if (userId === "U456") return "";
        return "Alice";
      },
    );

    expect(labels).toEqual({ U789: "Alice" });
  });
});

describe("buildSlackChannelLabelMap", () => {
  test("dedupes unlabeled channel references and resolves them in parallel", async () => {
    const resolved: string[] = [];
    const labels = await buildSlackChannelLabelMap(
      ["<#C123> hi <#G999> <#G999>", undefined, "<#C123> and <#D456>"],
      async (channelId) => {
        resolved.push(channelId);
        if (channelId === "G999") return "private-team";
        return channelId === "D456" ? "direct-chat" : "general";
      },
    );

    expect(resolved.sort()).toEqual(["C123", "D456", "G999"]);
    expect(labels).toEqual({
      C123: "general",
      D456: "direct-chat",
      G999: "private-team",
    });
  });

  test("does not resolve channel references that already have usable embedded labels", async () => {
    const resolved: string[] = [];
    const labels = await buildSlackChannelLabelMap(
      ["<#C123|general> <#C456> <#C789|C789> <#CEMPTY|   >"],
      async (channelId) => {
        resolved.push(channelId);
        return channelId === "C456"
          ? "support"
          : channelId === "CEMPTY"
            ? "empty-label"
            : "resolved";
      },
    );

    expect(resolved.sort()).toEqual(["C456", "C789", "CEMPTY"]);
    expect(labels).toEqual({
      C456: "support",
      C789: "resolved",
      CEMPTY: "empty-label",
    });
  });

  test("omits unresolved labels and labels equal to the Slack channel ID", async () => {
    const labels = await buildSlackChannelLabelMap(
      ["<#C123> <#C456> <#C789>"],
      async (channelId) => {
        if (channelId === "C123") return "C123";
        if (channelId === "C456") return "";
        return "support";
      },
    );

    expect(labels).toEqual({ C789: "support" });
  });
});
