import { describe, expect, test } from "bun:test";

import {
  htmlToPlainText,
  mapAttachment,
  mapEmailMessage,
  pickBody,
} from "./map-email-message";

describe("mapEmailMessage", () => {
  test("carries the platform row's fields and leaves the rest unset", () => {
    const row = mapEmailMessage({
      id: "m1",
      direction: "inbound",
      from_address: "maya@northwind.co",
      to_addresses: ["hi@velly.vellum.me", "cc@example.com"],
      subject: "Q4 vendor contract",
      created_at: "2026-09-16T09:52:00Z",
    });
    expect(row).toEqual({
      id: "m1",
      direction: "inbound",
      from: { address: "maya@northwind.co" },
      to: [{ address: "hi@velly.vellum.me" }, { address: "cc@example.com" }],
      subject: "Q4 vendor contract",
      createdAt: "2026-09-16T09:52:00Z",
    });
    expect(row.snippet).toBeUndefined();
    expect(row.body).toBeUndefined();
    expect(row.attachments).toBeUndefined();
  });

  test("reads any direction other than outbound as inbound", () => {
    const base = {
      id: "m",
      from_address: "a@b.c",
      to_addresses: [],
      subject: "",
      created_at: "2026-01-01T00:00:00Z",
    };
    expect(mapEmailMessage({ ...base, direction: "outbound" }).direction).toBe(
      "outbound",
    );
    expect(mapEmailMessage({ ...base, direction: "inbound" }).direction).toBe(
      "inbound",
    );
    expect(mapEmailMessage({ ...base, direction: "weird" }).direction).toBe(
      "inbound",
    );
  });
});

describe("mapAttachment", () => {
  test("renames the daemon's snake_case fields", () => {
    expect(
      mapAttachment({
        id: "a1",
        filename: "deck.pdf",
        content_type: "application/pdf",
        size_bytes: 1234,
      }),
    ).toEqual({
      id: "a1",
      filename: "deck.pdf",
      contentType: "application/pdf",
      sizeBytes: 1234,
    });
  });
});

describe("pickBody", () => {
  test("prefers the text part", () => {
    expect(
      pickBody({ body_text: "Hello\n\nBye", body_html: "<p>Hello</p>" }),
    ).toBe("Hello\n\nBye");
  });

  test("flattens HTML when there is no text part", () => {
    expect(
      pickBody({
        body_text: "  ",
        body_html: "<p>Hi &amp; hello</p><p>Line one<br>line two</p>",
      }),
    ).toBe("Hi & hello\n\nLine one\nline two");
  });

  test("is empty when neither part came", () => {
    expect(pickBody({ body_text: null, body_html: null })).toBe("");
  });
});

describe("htmlToPlainText", () => {
  test("does not carry markup or scripts into the text", () => {
    expect(htmlToPlainText("<div>safe<script>alert(1)</script></div>")).toBe(
      "safealert(1)",
    );
    expect(htmlToPlainText("<b>bold</b> <i>it</i>")).toBe("bold it");
  });
});
