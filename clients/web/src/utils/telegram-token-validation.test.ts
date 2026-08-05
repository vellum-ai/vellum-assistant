import { describe, expect, it } from "bun:test";

import { validateTelegramToken } from "./telegram-token-validation";

const SECRET = "AAHkO1Qb2cRs3TuVw4XyZ5aBcDeFgHiJkLm";
const VALID = `123456789:${SECRET}`;

describe("validateTelegramToken", () => {
  it("accepts a well-formed token", () => {
    expect(validateTelegramToken(VALID)).toBeNull();
  });

  it("accepts the underscore and hyphen BotFather can emit", () => {
    expect(
      validateTelegramToken("123456789:AAHkO1Qb-cRs3TuVw4XyZ5aBcD_FgHiJkLm"),
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
    expect(validateTelegramToken(`123456789${SECRET}`)).toMatch(
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
    expect(validateTelegramToken("123456789:AAHkO1Qb2cRs")).toBe(
      "Bot token looks truncated. Copy the whole line from BotFather.",
    );
  });

  it("ignores surrounding whitespace from a sloppy paste", () => {
    expect(validateTelegramToken(`  ${VALID}  `)).toBeNull();
  });
});
