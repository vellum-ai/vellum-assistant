import { describe, expect, test } from "bun:test";

import {
  classifyLeadingReservedInjection,
  concatenateAssistantText,
  RESERVED_INJECTION_OPENER_PATTERN,
  RESERVED_INJECTION_TAG_NAMES,
} from "../context/reserved-injection-envelope.js";

describe("classifyLeadingReservedInjection", () => {
  test("treats leading whitespace before a reserved opener as reserved", () => {
    expect(
      classifyLeadingReservedInjection("  \n<turn_context>\nnow", {
        complete: true,
      }),
    ).toEqual({ status: "reserved", tag: "turn_context" });
  });

  test("leaves mid-message reserved tags alone", () => {
    expect(
      classifyLeadingReservedInjection(
        "The ACK is clean. An example <turn_context> block is injected each turn.",
        { complete: true },
      ),
    ).toEqual({ status: "clean" });
  });

  test("leaves quoted tag names alone", () => {
    expect(
      classifyLeadingReservedInjection(
        'Do not emit "<memory_spotlight>" in your reply.',
        { complete: true },
      ),
    ).toEqual({ status: "clean" });
  });

  test("classifies each reserved opener", () => {
    for (const tag of RESERVED_INJECTION_TAG_NAMES) {
      expect(
        classifyLeadingReservedInjection(`<${tag}>\npayload`, {
          complete: true,
        }),
      ).toEqual({ status: "reserved", tag });
    }
  });

  test("matches reserved openers case-insensitively", () => {
    expect(
      classifyLeadingReservedInjection("<TURN_CONTEXT> leaked", {
        complete: true,
      }),
    ).toEqual({ status: "reserved", tag: "turn_context" });
  });

  test("treats an incomplete < as pending while streaming", () => {
    expect(classifyLeadingReservedInjection("<")).toEqual({
      status: "pending",
    });
    expect(classifyLeadingReservedInjection("<turn")).toEqual({
      status: "pending",
    });
    expect(classifyLeadingReservedInjection("<turn_context")).toEqual({
      status: "pending",
    });
  });

  test("treats a finished incomplete < as clean unless the name is reserved", () => {
    expect(
      classifyLeadingReservedInjection("<", { complete: true }),
    ).toEqual({ status: "clean" });
    expect(
      classifyLeadingReservedInjection("<turn", { complete: true }),
    ).toEqual({ status: "clean" });
    expect(
      classifyLeadingReservedInjection("<turn_context", { complete: true }),
    ).toEqual({ status: "reserved", tag: "turn_context" });
  });

  test("releases a non-reserved tag as soon as it cannot become reserved", () => {
    expect(classifyLeadingReservedInjection("<div")).toEqual({
      status: "clean",
    });
    expect(classifyLeadingReservedInjection("<hello>")).toEqual({
      status: "clean",
    });
  });

  test("does not treat a closing tag as a reserved opener", () => {
    expect(
      classifyLeadingReservedInjection("</turn_context>", { complete: true }),
    ).toEqual({ status: "clean" });
  });

  test("empty complete text is clean; empty streaming text stays pending", () => {
    expect(classifyLeadingReservedInjection("   ", { complete: true })).toEqual({
      status: "clean",
    });
    expect(classifyLeadingReservedInjection("   ")).toEqual({
      status: "pending",
    });
  });
});

describe("RESERVED_INJECTION_OPENER_PATTERN", () => {
  test("flags a reserved tag anywhere in a summary", () => {
    expect(RESERVED_INJECTION_OPENER_PATTERN.test("A <memory_spotlight> leak")).toBe(
      true,
    );
    expect(RESERVED_INJECTION_OPENER_PATTERN.test("plain memory mention")).toBe(
      false,
    );
  });
});

describe("concatenateAssistantText", () => {
  test("joins text blocks and ignores tool_use", () => {
    expect(
      concatenateAssistantText([
        { type: "text", text: "<turn_context>" },
        { type: "tool_use" },
        { type: "text", text: "\nleaked" },
      ]),
    ).toBe("<turn_context>\nleaked");
  });
});
