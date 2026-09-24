import { describe, expect, test } from "bun:test";

import type { EmailReference } from "@/types/email-reference";

import {
  EMAIL_REFERENCE_SNIPPET_MAX,
  formatEmailReference,
  prependEmailReferences,
} from "./email-reference";

const RECEIVED: EmailReference = {
  id: "msg_in_1",
  direction: "inbound",
  from: { name: "Maya Chen", address: "maya@northwind.co" },
  to: [{ address: "hi@velly.vellum.me" }],
  subject: "Q4 vendor contract",
  createdAt: "2026-09-16T09:52:00Z",
  snippet: "Attaching the redline for a look before Friday.",
};

const SENT: EmailReference = {
  id: "msg_out_1",
  direction: "outbound",
  from: { name: "Velly", address: "hi@velly.vellum.me" },
  to: [{ name: "Sam Okafor", address: "sam@example.com" }],
  subject: "",
  createdAt: "2026-09-15T18:00:00Z",
};

describe("formatEmailReference", () => {
  test("quotes every line and carries the header fields the assistant reads", () => {
    const lines = formatEmailReference(RECEIVED).split("\n");
    expect(lines[0]).toBe("> [vellum:email-reference]");
    expect(lines.at(-1)).toBe("> [/vellum:email-reference]");
    expect(lines.every((line) => line.startsWith("> "))).toBe(true);
    expect(lines).toContain("> message-id: msg_in_1");
    expect(lines).toContain("> direction: received");
    expect(lines).toContain("> from: Maya Chen <maya@northwind.co>");
    expect(lines).toContain("> to: hi@velly.vellum.me");
    expect(lines).toContain("> subject: Q4 vendor contract");
    expect(lines).toContain("> sent-at: 2026-09-16T09:52:00Z");
    expect(lines).toContain(
      "> snippet: Attaching the redline for a look before Friday.",
    );
    expect(lines).toContain(
      "> full-message: assistant email download msg_in_1",
    );
  });

  test("omits absent fields rather than emitting them empty", () => {
    const block = formatEmailReference(SENT);
    expect(block).toContain("> direction: sent");
    expect(block).toContain("> to: Sam Okafor <sam@example.com>");
    expect(block).not.toContain("subject:");
    expect(block).not.toContain("snippet:");
  });

  test("bounds a long snippet and collapses its whitespace", () => {
    const block = formatEmailReference({
      ...RECEIVED,
      snippet: `line one\n\n   line two ${"x".repeat(EMAIL_REFERENCE_SNIPPET_MAX)}`,
    });
    const snippetLine = block
      .split("\n")
      .find((line) => line.startsWith("> snippet: "))!;
    const snippet = snippetLine.slice("> snippet: ".length);
    expect(snippet.startsWith("line one line two")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(EMAIL_REFERENCE_SNIPPET_MAX + 1);
  });
});

describe("prependEmailReferences", () => {
  test("leaves content alone with nothing staged", () => {
    expect(prependEmailReferences("hello", [])).toBe("hello");
  });

  test("leads with the blocks in staged order, then the remark", () => {
    const result = prependEmailReferences("summarise these", [RECEIVED, SENT]);
    const first = result.indexOf("msg_in_1");
    const second = result.indexOf("msg_out_1");
    expect(result.startsWith("> [vellum:email-reference]")).toBe(true);
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(result.endsWith("\n\nsummarise these")).toBe(true);
  });

  test("with no remark the blocks are the whole message", () => {
    const result = prependEmailReferences("", [RECEIVED]);
    expect(result).toBe(formatEmailReference(RECEIVED));
  });
});
