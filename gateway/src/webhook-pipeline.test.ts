import { describe, expect, test } from "bun:test";

import { isNewCommand } from "./webhook-pipeline.js";

describe("isNewCommand", () => {
  test("matches bare /new", () => {
    expect(isNewCommand("/new")).toBe(true);
    expect(isNewCommand("  /new  ")).toBe(true);
  });

  test("matches /new@BotName from the Telegram command menu", () => {
    expect(isNewCommand("/new@MyBot")).toBe(true);
    expect(isNewCommand("/new@my_bot")).toBe(true);
  });

  test("matches /new with trailing whitespace", () => {
    expect(isNewCommand("/new ")).toBe(true);
    expect(isNewCommand("/new@MyBot ")).toBe(true);
  });

  test("rejects other commands and prefixes", () => {
    expect(isNewCommand("/newer")).toBe(false);
    expect(isNewCommand("/news")).toBe(false);
    expect(isNewCommand("/fork")).toBe(false);
    expect(isNewCommand("please /new")).toBe(false);
  });
});
