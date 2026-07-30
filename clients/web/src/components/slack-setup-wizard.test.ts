import { describe, expect, it } from "bun:test";

import { validateSlackToken } from "./slack-setup-wizard";

const BOT = "xoxb-";
const APP = "xapp-";

describe("validateSlackToken", () => {
  it("accepts a well-formed bot token", () => {
    expect(
      validateSlackToken(
        `${BOT}0000000000-0000000000-abcdefghij`,
        BOT,
        "Bot token",
      ),
    ).toBeNull();
  });

  it("accepts a well-formed app token", () => {
    expect(
      validateSlackToken(
        `${APP}1-A012345678-0123456789-abcdef`,
        APP,
        "App token",
      ),
    ).toBeNull();
  });

  it("treats an empty field as not-yet-an-error", () => {
    expect(validateSlackToken("", BOT, "Bot token")).toBeNull();
    expect(validateSlackToken("   ", BOT, "Bot token")).toBeNull();
  });

  it("rejects a token with the wrong prefix", () => {
    expect(
      validateSlackToken(`${APP}0000000000-abcdefghij`, BOT, "Bot token"),
    ).toBe('Bot token should start with "xoxb-".');
    expect(
      validateSlackToken(`${BOT}0000000000-abcdefghij`, APP, "App token"),
    ).toBe('App token should start with "xapp-".');
  });

  it("rejects a token with no recognizable prefix", () => {
    expect(validateSlackToken("not-a-token-at-all", BOT, "Bot token")).toBe(
      'Bot token should start with "xoxb-".',
    );
  });

  it("rejects a correctly-prefixed but truncated token", () => {
    expect(validateSlackToken(`${BOT}123`, BOT, "Bot token")).toBe(
      "Bot token looks truncated — copy the whole value from Slack.",
    );
  });

  it("ignores surrounding whitespace from a sloppy paste", () => {
    expect(
      validateSlackToken(
        `  ${BOT}0000000000-0000000000-abcdefghij  `,
        BOT,
        "Bot token",
      ),
    ).toBeNull();
  });
});
