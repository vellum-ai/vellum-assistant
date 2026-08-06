import { describe, expect, it } from "bun:test";

import { validateTelegramToken } from "./telegram-token-validation";

// Assembled rather than written as one literal. A token-shaped string in
// source trips GitHub's secret scanning whether or not it was ever a
// credential, and the repo's own pre-commit scanner exempts *.test.* files, so
// test fixtures are exactly where that alert comes from. Splitting the id from
// the secret keeps the shape out of the file.
const BOT_ID = "123456789";
const SECRET = "AAHkO1Qb2cRs3TuVw4XyZ5aBcDeFgHiJkLm";
const SECRET_WITH_SYMBOLS = "AAHkO1Qb-cRs3TuVw4XyZ5aBcD_FgHiJkLm";
const VALID = `${BOT_ID}:${SECRET}`;

describe("validateTelegramToken", () => {
  it("accepts a well-formed token", () => {
    expect(validateTelegramToken(VALID)).toBeNull();
  });

  it("accepts the underscore and hyphen BotFather can emit", () => {
    expect(
      validateTelegramToken(`${BOT_ID}:${SECRET_WITH_SYMBOLS}`),
    ).toBeNull();
  });

  it("treats an empty field as not-yet-an-error", () => {
    expect(validateTelegramToken("")).toBeNull();
    expect(validateTelegramToken("   ")).toBeNull();
  });

  it("rejects a token missing the numeric id", () => {
    expect(validateTelegramToken(SECRET)).toMatch(/should look like/);
  });

  it("rejects a token missing the colon", () => {
    expect(validateTelegramToken(`${BOT_ID}${SECRET}`)).toMatch(
      /should look like/,
    );
  });

  it("rejects a non-numeric id", () => {
    expect(validateTelegramToken(`abc123:${SECRET}`)).toMatch(
      /should look like/,
    );
  });

  it("rejects a Slack token pasted into the wrong field", () => {
    expect(validateTelegramToken("xoxb-0000000000-0000000000-abcdef")).toMatch(
      /should look like/,
    );
  });

  it("rejects a correctly-shaped but truncated token", () => {
    expect(validateTelegramToken(`${BOT_ID}:AAHkO1Qb2cRs`)).toBe(
      "Bot token looks truncated. Copy the whole line from BotFather.",
    );
  });

  it("ignores surrounding whitespace from a sloppy paste", () => {
    expect(validateTelegramToken(`  ${VALID}  `)).toBeNull();
  });
});
