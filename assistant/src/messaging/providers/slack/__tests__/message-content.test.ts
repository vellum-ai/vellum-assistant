import { describe, expect, test } from "bun:test";

import { slackMessageRawText } from "../message-content.js";

describe("slackMessageRawText", () => {
  test("returns top-level text untouched when present", () => {
    expect(
      slackMessageRawText({
        text: "hello <@U123>",
        attachments: [{ fallback: "ignored" }],
      }),
    ).toBe("hello <@U123>");
  });

  test("whitespace-only text falls through to attachments", () => {
    expect(
      slackMessageRawText({
        text: "  \n ",
        attachments: [{ fallback: "the fallback" }],
      }),
    ).toBe("the fallback");
  });

  test("prefers structured attachment fields over fallback", () => {
    expect(
      slackMessageRawText({
        text: "",
        attachments: [
          {
            fallback: "plain summary",
            pretext: "build failed by <@U08E>",
            author_name: "CI",
            title: "CI Main Web",
            title_link: "https://example.com/runs/1",
            text: "3 tests failing",
            fields: [
              { title: "Branch", value: "main" },
              { title: "", value: "value-only" },
            ],
            footer: "workflow #12",
          },
        ],
      }),
    ).toBe(
      [
        "build failed by <@U08E>",
        "CI",
        "CI Main Web (https://example.com/runs/1)",
        "3 tests failing",
        "Branch: main",
        "value-only",
        "workflow #12",
      ].join("\n"),
    );
  });

  test("uses fallback when the attachment has no structured text", () => {
    expect(
      slackMessageRawText({
        text: "",
        attachments: [{ fallback: "only the fallback" }],
      }),
    ).toBe("only the fallback");
  });

  test("joins multiple attachments with newlines and drops empty ones", () => {
    expect(
      slackMessageRawText({
        text: "",
        attachments: [{ text: "first" }, {}, { fallback: "second" }],
      }),
    ).toBe("first\nsecond");
  });

  test("extracts section, header, and context block text ahead of attachments", () => {
    expect(
      slackMessageRawText({
        text: "",
        blocks: [
          {
            type: "header",
            text: { type: "plain_text", text: "Release v1.2" },
          },
          {
            type: "section",
            text: { type: "mrkdwn", text: "All green" },
            fields: [
              { type: "mrkdwn", text: "Env: prod" },
              { type: "mrkdwn", text: "" },
            ],
          },
          { type: "divider" },
          {
            type: "context",
            elements: [
              { type: "mrkdwn", text: "deployed by <@U42>" },
              { type: "plain_text", text: "just now" },
            ],
          },
        ],
        attachments: [{ fallback: "attachment tail" }],
      }),
    ).toBe(
      [
        "Release v1.2",
        "All green",
        "Env: prod",
        "deployed by <@U42> just now",
        "attachment tail",
      ].join("\n"),
    );
  });

  test("extracts markdown block text", () => {
    expect(
      slackMessageRawText({
        text: "",
        blocks: [
          { type: "markdown", text: "**Deploy failed** on `main`" },
          { type: "divider" },
        ],
      }),
    ).toBe("**Deploy failed** on `main`");
  });

  test("extracts blocks nested inside an attachment", () => {
    expect(
      slackMessageRawText({
        text: "",
        attachments: [
          {
            fallback: "plain summary",
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: "Run #7 red" } },
              { type: "markdown", text: "3 tests failing" },
            ],
          },
        ],
      }),
    ).toBe("Run #7 red\n3 tests failing");
  });

  test("returns empty string when nothing carries text", () => {
    expect(
      slackMessageRawText({
        text: "",
        blocks: [{ type: "divider" }],
        attachments: [{}],
      }),
    ).toBe("");
  });
});
