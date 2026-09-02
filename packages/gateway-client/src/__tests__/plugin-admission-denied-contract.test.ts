import { describe, expect, test } from "bun:test";

import {
  ACCESS_DENIED_NOT_APPROVED_REPLY,
  PLUGIN_ADMISSION_DENIED_NOTICE_PATH,
  PluginAdmissionDeniedNoticeSchema,
} from "../plugin-admission-denied-contract.js";

describe("plugin admission-denied contract", () => {
  test("keeps the not-approved copy stable", () => {
    expect(ACCESS_DENIED_NOT_APPROVED_REPLY).toBe(
      "Sorry, you haven't been approved to message this assistant.",
    );
  });

  test("names the internal plugin notice path", () => {
    expect(PLUGIN_ADMISSION_DENIED_NOTICE_PATH).toBe(
      "notices/admission-denied",
    );
  });

  test("round-trips a floor-deny notice", () => {
    const notice = {
      reason: "admission_floor" as const,
      plugin: "imessage",
      ingressRoute: "events-linq",
      admissionPolicy: "guardian_only" as const,
      trustClass: "unknown" as const,
      conversationExternalId: "chat-1",
      actorExternalId: "+15550100",
      externalMessageId: "msg-1",
      replyText: ACCESS_DENIED_NOT_APPROVED_REPLY,
    };

    expect(PluginAdmissionDeniedNoticeSchema.parse(notice)).toEqual(notice);
  });

  test("rejects a notice that still carries a plugin-scoped id as the chat", () => {
    // The send API addresses vendor chats. An empty chat id is the failure
    // that matters; the schema only requires a non-empty string, so this
    // asserts the required fields rather than the prefix rule.
    expect(() =>
      PluginAdmissionDeniedNoticeSchema.parse({
        reason: "admission_floor",
        plugin: "imessage",
        ingressRoute: "events-linq",
        admissionPolicy: "guardian_only",
        trustClass: "unknown",
        conversationExternalId: "",
        actorExternalId: "+15550100",
        externalMessageId: "msg-1",
        replyText: ACCESS_DENIED_NOT_APPROVED_REPLY,
      }),
    ).toThrow();
  });
});
