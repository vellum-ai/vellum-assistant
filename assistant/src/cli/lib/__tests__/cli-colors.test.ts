import { afterEach, describe, expect, it } from "bun:test";

import { red, yellow } from "../cli-colors.js";

const originalIsTTY = process.stderr.isTTY;
const originalNoColor = process.env.NO_COLOR;

function setTTY(value: boolean): void {
  Object.defineProperty(process.stderr, "isTTY", {
    configurable: true,
    value,
  });
}

describe("red", () => {
  afterEach(() => {
    setTTY(originalIsTTY);
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }
  });

  it("returns plain text when stderr is not a TTY", () => {
    setTTY(false);
    delete process.env.NO_COLOR;
    expect(red("oops")).toBe("oops");
  });

  it("wraps text in ANSI red when stderr is a TTY", () => {
    setTTY(true);
    delete process.env.NO_COLOR;
    expect(red("oops")).toBe("\x1b[31moops\x1b[0m");
  });

  it("respects NO_COLOR even when stderr is a TTY", () => {
    setTTY(true);
    process.env.NO_COLOR = "1";
    expect(red("oops")).toBe("oops");
  });

  it("treats an empty NO_COLOR as unset (per no-color.org)", () => {
    setTTY(true);
    process.env.NO_COLOR = "";
    expect(red("oops")).toBe("\x1b[31moops\x1b[0m");
  });
});

describe("yellow", () => {
  afterEach(() => {
    setTTY(originalIsTTY);
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }
  });

  it("returns plain text when stderr is not a TTY", () => {
    setTTY(false);
    delete process.env.NO_COLOR;
    expect(yellow("warn")).toBe("warn");
  });

  it("wraps text in ANSI yellow when stderr is a TTY", () => {
    setTTY(true);
    delete process.env.NO_COLOR;
    expect(yellow("warn")).toBe("\x1b[33mwarn\x1b[0m");
  });

  it("respects NO_COLOR even when stderr is a TTY", () => {
    setTTY(true);
    process.env.NO_COLOR = "1";
    expect(yellow("warn")).toBe("warn");
  });
});
