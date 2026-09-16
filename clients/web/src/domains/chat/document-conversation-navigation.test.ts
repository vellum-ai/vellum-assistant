import { describe, expect, test } from "bun:test";

import {
  documentConversationUrl,
  documentReturnPath,
  getDocumentConversationRoute,
} from "./document-conversation-navigation";

describe("document presentation URLs", () => {
  test("document intent and safe origin survive a URL round trip", () => {
    const url = documentConversationUrl(
      "conv-linked",
      "surface-1",
      "/assistant/conversations/conv-origin",
    );
    expect(getDocumentConversationRoute(url.slice(url.indexOf("?")))).toEqual({
      surfaceId: "surface-1",
      showingDocument: true,
      returnTo: "/assistant/conversations/conv-origin",
    });
  });
  test("viewing the transcript retains a document reopen target", () => {
    const url = documentConversationUrl(
      "conv-linked",
      "surface-1",
      "/assistant/library",
      "chat",
    );
    expect(getDocumentConversationRoute(url.slice(url.indexOf("?")))).toEqual({
      surfaceId: "surface-1",
      showingDocument: false,
      returnTo: "/assistant/library",
    });
  });
  test.each(["/assistant/conversations/conv-origin/", "/assistant/library/"])(
    "the trailing-slash origin %s survives the document URL round trip",
    (origin) => {
      const url = documentConversationUrl("conv-linked", "surface-1", origin);
      expect(documentReturnPath(origin)).toBe(origin);
      expect(
        getDocumentConversationRoute(url.slice(url.indexOf("?"))).returnTo,
      ).toBe(origin);
    },
  );
  test("external URLs and send-triggering query parameters cannot become return targets", () => {
    for (const target of [
      "https://example.com",
      "//example.com",
      "/assistant/conversations/conv-1?prompt=send",
      "/assistant/conversations/conv-1/?prompt=send",
      "/assistant/conversations/conv-1/#fragment",
      "/assistant/conversations/conv-1//",
      "/assistant/conversations/../settings",
      "/assistant/conversations/conv-1\\path",
      "/assistant/library//",
      "/assistant/library/?prompt=send",
      "/assistant/library/#fragment",
    ]) {
      expect(documentReturnPath(target)).toBe("/assistant/library");
    }
    expect(documentReturnPath(null)).toBe("/assistant/library");
  });
});
