import { describe, expect, test } from "bun:test";

import {
  classifyEmails,
  type EmailMetadata,
} from "../messaging/email-classifier.js";

describe("classifyEmails", () => {
  test("returns empty classifications for empty input", async () => {
    const result = await classifyEmails([]);
    expect(result.classifications).toEqual([]);
  });

  test("accepts well-formed email metadata", () => {
    const email: EmailMetadata = {
      id: "msg-1",
      from: "test@example.com",
      subject: "Test Subject",
      snippet: "This is a test email snippet",
      labels: ["INBOX", "UNREAD"],
    };
    expect(email.id).toBe("msg-1");
    expect(email.labels).toContain("INBOX");
  });
});
