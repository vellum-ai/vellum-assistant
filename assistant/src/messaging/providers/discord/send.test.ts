/**
 * The Discord request shape, asserted against a stubbed fetch.
 *
 * `render.test.ts` covers how a reply is split; this covers what actually
 * goes on the wire: the route, the auth header, the mention policy, chunk
 * ordering, and the documented multipart upload form. Those are the parts a
 * unit test can hold, and the parts whose breakage is silent (a wrong route
 * 404s into a failed delivery, a missing `allowed_mentions` pings a server).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const BOT_TOKEN = "discord-bot-token";

const realSecureKeys = await import("../../../security/secure-keys.js");
mock.module("../../../security/secure-keys.js", () => ({
  ...realSecureKeys,
  getSecureKeyResultAsync: async () => ({
    value: BOT_TOKEN,
    unreachable: false,
  }),
}));

mock.module("../../../persistence/attachments-store.js", () => ({
  getAttachmentContent: (id: string) =>
    id === "missing" ? null : Buffer.from("file-bytes"),
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const { sendDiscordReply, sendDiscordAttachments } = await import("./send.js");

const originalFetch = globalThis.fetch;

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let calls: Captured[] = [];

function stubFetch(status = 200, payload: unknown = { id: "msg-1" }): void {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(
      new Headers(init?.headers ?? {}).entries(),
    );
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers,
      body: init?.body,
    });
    return new Response(status === 204 ? null : JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls = [];
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("sendDiscordReply", () => {
  test("posts to the channel's messages route with bot auth", async () => {
    await sendDiscordReply({ channelId: "C1" }, "hello");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://discord.com/api/v10/channels/C1/messages",
    );
    expect(calls[0].method).toBe("POST");
    // Discord rejects a bare token: the scheme prefix is required.
    expect(calls[0].headers.authorization).toBe(`Bot ${BOT_TOKEN}`);
  });

  test("withholds everyone and role mentions", async () => {
    // The agent composes this text and may echo mention markup from an
    // untrusted inbound message, so it must never be able to ping a whole
    // server. Losing this field is silent until it pings 5000 people.
    await sendDiscordReply({ channelId: "C1" }, "@everyone hi <@&12345>");

    const body = JSON.parse(calls[0].body as string);
    expect(body.allowed_mentions).toEqual({ parse: ["users"] });
    expect(body.allowed_mentions.parse).not.toContain("everyone");
    expect(body.allowed_mentions.parse).not.toContain("roles");
    // The text itself is passed through unaltered; the policy does the work.
    expect(body.content).toBe("@everyone hi <@&12345>");
  });

  test("targets a thread by its own id, never the parent channel", async () => {
    await sendDiscordReply({ channelId: "T9" }, "in thread");
    expect(calls[0].url).toContain("/channels/T9/messages");
  });

  test("sends long replies as ordered chunks, each carrying the policy", async () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const result = await sendDiscordReply({ channelId: "C1" }, long);

    expect(calls.length).toBeGreaterThan(1);
    const contents = calls.map((c) => JSON.parse(c.body as string).content);
    // Reassembles in send order, so the reply reads top to bottom.
    expect(contents.join("\n")).toBe(long);
    for (const call of calls) {
      expect(JSON.parse(call.body as string).allowed_mentions).toEqual({
        parse: ["users"],
      });
    }
    expect(result.lastMessageId).toBe("msg-1");
  });

  test("sends nothing for blank text", async () => {
    await sendDiscordReply({ channelId: "C1" }, "   ");
    expect(calls).toHaveLength(0);
  });
});

describe("sendDiscordAttachments", () => {
  test("uploads with the documented multipart form", async () => {
    const result = await sendDiscordAttachments({ channelId: "C1" }, [
      { id: "a1", filename: "report.pdf", mimeType: "application/pdf" },
    ] as never);

    expect(result.allFailed).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://discord.com/api/v10/channels/C1/messages",
    );

    const form = calls[0].body as FormData;
    expect(form).toBeInstanceOf(FormData);
    // Files ride as `files[n]`, with the JSON body moved to `payload_json`
    // and each file declared in `attachments` keyed by the same n.
    expect(form.get("files[0]")).toBeInstanceOf(Blob);
    const payload = JSON.parse(form.get("payload_json") as string);
    expect(payload.attachments).toEqual([{ id: 0, filename: "report.pdf" }]);
    expect(payload.allowed_mentions).toEqual({ parse: ["users"] });

    // fetch must derive the multipart boundary, so Content-Type stays unset.
    expect(calls[0].headers["content-type"]).toBeUndefined();
  });

  test("reports a refused upload instead of claiming success", async () => {
    stubFetch(413, { message: "Request entity too large" });

    const result = await sendDiscordAttachments({ channelId: "C1" }, [
      { id: "a1", filename: "huge.bin" },
    ] as never);

    expect(result.allFailed).toBe(true);
    expect(result.failureCount).toBe(1);
    // The user gets a notice naming the file, not silence.
    const notice = calls
      .filter((c) => typeof c.body === "string")
      .map((c) => JSON.parse(c.body as string).content)
      .join(" ");
    expect(notice).toContain("huge.bin");
    expect(notice).toContain("413");
  });

  test("does not upload an attachment whose content is gone", async () => {
    const result = await sendDiscordAttachments({ channelId: "C1" }, [
      { id: "missing", filename: "ghost.txt" },
    ] as never);

    expect(result.allFailed).toBe(true);
    // Only the failure notice, never a zero-byte upload.
    expect(calls.every((c) => typeof c.body === "string")).toBe(true);
  });
});
