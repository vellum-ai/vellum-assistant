import { afterEach, describe, expect, test } from "bun:test";
import type { NavigateFunction } from "react-router";

import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";

import {
  documentConversationUrl,
  documentReturnPath,
  getDocumentConversationRoute,
  returnFromDocument,
} from "./document-conversation-navigation";

const conversation = useConversationStore.getState();
const viewer = useViewerStore.getState();

afterEach(() => {
  useConversationStore.setState(conversation, true);
  useViewerStore.setState(viewer, true);
});

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
      "/assistant/conversations/conv-1/inspect",
      "/assistant/conversations/conv-1/app/",
      "/assistant/conversations/conv-1/app/app-1?prompt=send",
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
  test.each([
    "/assistant/conversations/conv-origin/app/app-1",
    "/assistant/conversations/conv-origin/app/app-1/",
  ])("the app sub-route %s returns to its conversation", (origin) => {
    expect(documentReturnPath(origin)).toBe(
      "/assistant/conversations/conv-origin",
    );
    const url = documentConversationUrl("conv-linked", "surface-1", origin);
    expect(
      getDocumentConversationRoute(url.slice(url.indexOf("?"))).returnTo,
    ).toBe("/assistant/conversations/conv-origin");
  });
});

describe("returning from a document without a history entry", () => {
  test.each([
    ["/assistant/conversations/conv-origin", "conv-origin"],
    ["/assistant/conversations/conv-origin/", "conv-origin"],
    ["/assistant/conversations/conv-origin/app/app-1", "conv-origin"],
  ])("%s selects conversation %s", (returnTo, conversationId) => {
    useConversationStore.setState({ activeConversationId: null });
    const visited: string[] = [];
    const navigate = ((to: string) => {
      visited.push(to);
    }) as unknown as NavigateFunction;
    returnFromDocument(navigate, "surface-1", returnTo, null);
    expect(useConversationStore.getState().activeConversationId).toBe(
      conversationId,
    );
    expect(visited).toEqual([returnTo]);
  });
  test("the library root falls back to a plain navigation", () => {
    useConversationStore.setState({ activeConversationId: null });
    const visited: string[] = [];
    const navigate = ((to: string) => {
      visited.push(to);
    }) as unknown as NavigateFunction;
    returnFromDocument(navigate, "surface-1", "/assistant/library", null);
    expect(useConversationStore.getState().activeConversationId).toBeNull();
    expect(visited).toEqual(["/assistant/library"]);
  });
});
