import { describe, expect, test } from "bun:test";

import { parseShareInboxItem } from "@/runtime/share-inbox-parse";

describe("parseShareInboxItem", () => {
  test("parses a new-conversation item with files", () => {
    expect(
      parseShareInboxItem({
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
      }),
    ).toEqual({
      id: "inbox-1",
      destination: { type: "new" },
      text: "hello",
      files: [
        { name: "shot.png", mimeType: "image/png", path: "/tmp/shot.png" },
      ],
    });
  });

  test("parses a thread destination and fills a missing mime type", () => {
    expect(
      parseShareInboxItem({
        id: "inbox-2",
        destination: { type: "thread", threadId: "conv-xyz" },
        text: null,
        files: [{ name: "a.pdf", path: "/tmp/a.pdf" }],
      }),
    ).toEqual({
      id: "inbox-2",
      destination: { type: "thread", threadId: "conv-xyz" },
      text: null,
      files: [
        {
          name: "a.pdf",
          mimeType: "application/octet-stream",
          path: "/tmp/a.pdf",
        },
      ],
    });
  });

  test("drops an empty payload and malformed destinations", () => {
    expect(
      parseShareInboxItem({
        id: "empty",
        destination: { type: "new" },
        text: "  ",
        files: [],
      }),
    ).toBeNull();
    expect(
      parseShareInboxItem({
        id: "inbox-1",
        destination: { type: "thread" },
        text: "hello",
        files: [],
      }),
    ).toBeNull();
    expect(parseShareInboxItem(null)).toBeNull();
    expect(parseShareInboxItem({})).toBeNull();
  });
});
