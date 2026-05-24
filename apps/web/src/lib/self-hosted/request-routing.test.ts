import { describe, expect, test } from "bun:test";

import { classifyAssistantPath } from "@/lib/self-hosted/request-routing.js";

const ID = "01h1234567890abcdefg";

describe("classifyAssistantPath", () => {
  test("returns null for non-assistant paths", () => {
    expect(classifyAssistantPath("/v1/feature-flags/")).toEqual({
      assistantId: null,
      isRuntimeProxied: false,
    });
  });

  test("returns null for the assistant collection root", () => {
    expect(classifyAssistantPath("/v1/assistants/")).toEqual({
      assistantId: null,
      isRuntimeProxied: false,
    });
  });

  test("treats bare /v1/assistants/{id}/ as platform-owned", () => {
    expect(classifyAssistantPath(`/v1/assistants/${ID}/`)).toEqual({
      assistantId: ID,
      isRuntimeProxied: false,
    });
  });

  test("treats the conversations subtree as runtime-proxied", () => {
    expect(
      classifyAssistantPath(`/v1/assistants/${ID}/conversations/`),
    ).toEqual({
      assistantId: ID,
      isRuntimeProxied: true,
    });
    expect(
      classifyAssistantPath(
        `/v1/assistants/${ID}/conversations/abc/messages/`,
      ),
    ).toEqual({
      assistantId: ID,
      isRuntimeProxied: true,
    });
  });

  test.each([
    "activate",
    "resize",
    "restart",
    "retire",
    "upgrade",
    "upgrade-status",
    "upgrade-policy",
    "rollback",
    "sleep-policy",
    "access-consent",
    "record-activity",
    "connection-status",
    "backups",
  ])("keeps platform action %s on the platform", (segment) => {
    expect(classifyAssistantPath(`/v1/assistants/${ID}/${segment}/`)).toEqual({
      assistantId: ID,
      isRuntimeProxied: false,
    });
  });

  test("treats arbitrary deep subpaths as runtime-proxied", () => {
    expect(
      classifyAssistantPath(`/v1/assistants/${ID}/feature-flags/sync/`),
    ).toEqual({
      assistantId: ID,
      isRuntimeProxied: true,
    });
  });

  test("treats contacts subtree as runtime-proxied", () => {
    expect(
      classifyAssistantPath(`/v1/assistants/${ID}/contacts/`),
    ).toEqual({
      assistantId: ID,
      isRuntimeProxied: true,
    });
  });
});
