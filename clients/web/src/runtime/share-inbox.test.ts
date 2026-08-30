import { beforeEach, describe, expect, mock, test } from "bun:test";

let capacitorPlatform = "ios";
const consumeMock = mock(async (_options: { id?: string }) => ({
  ok: true,
  item: null as unknown,
}));

mock.module("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => capacitorPlatform,
  },
  registerPlugin: () => ({
    consume: consumeMock,
    addListener: async () => ({ remove: async () => undefined }),
  }),
}));

const { consumeShareInbox } = await import("@/runtime/share-inbox");

beforeEach(() => {
  capacitorPlatform = "ios";
  consumeMock.mockClear();
  consumeMock.mockImplementation(async () => ({ ok: true, item: null }));
});

describe("consumeShareInbox", () => {
  test("returns null off iOS", async () => {
    capacitorPlatform = "web";
    expect(await consumeShareInbox("inbox-1")).toBeNull();
    expect(consumeMock).not.toHaveBeenCalled();
  });

  test("passes the id through and parses a new-conversation item", async () => {
    consumeMock.mockImplementation(async () => ({
      ok: true,
      item: {
        id: "inbox-1",
        destination: { type: "new" },
        text: "hello",
        files: [
          {
            name: "shot.png",
            mimeType: "image/png",
            path: "/tmp/shot.png",
          },
        ],
      },
    }));
    expect(await consumeShareInbox("inbox-1")).toEqual({
      id: "inbox-1",
      destination: { type: "new" },
      text: "hello",
      files: [
        { name: "shot.png", mimeType: "image/png", path: "/tmp/shot.png" },
      ],
    });
    expect(consumeMock).toHaveBeenCalledWith({ id: "inbox-1" });
  });

  test("omits id when taking the latest item", async () => {
    consumeMock.mockImplementation(async () => ({
      ok: true,
      item: {
        id: "inbox-2",
        destination: { type: "thread", threadId: "conv-xyz" },
        text: null,
        files: [{ name: "a.pdf", mimeType: "application/pdf", path: "/tmp/a.pdf" }],
      },
    }));
    expect(await consumeShareInbox(null)).toEqual({
      id: "inbox-2",
      destination: { type: "thread", threadId: "conv-xyz" },
      text: null,
      files: [
        { name: "a.pdf", mimeType: "application/pdf", path: "/tmp/a.pdf" },
      ],
    });
    expect(consumeMock).toHaveBeenCalledWith({});
  });

  test("drops an empty payload and a missing plugin", async () => {
    consumeMock.mockImplementation(async () => ({
      ok: true,
      item: { id: "empty", destination: { type: "new" }, text: "  ", files: [] },
    }));
    expect(await consumeShareInbox("empty")).toBeNull();

    consumeMock.mockImplementation(async () => {
      throw new Error("not implemented");
    });
    expect(await consumeShareInbox("inbox-1")).toBeNull();
  });
});
