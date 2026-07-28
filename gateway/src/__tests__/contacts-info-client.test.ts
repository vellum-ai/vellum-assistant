/**
 * Tests for the typed gateway → daemon contact info-read IPC client and its
 * thin callers, with `ipcCallAssistant` mocked (no daemon required).
 *
 * Verifies the wire shapes the gateway sends/receives and that
 * `findContactChannelByAddress` maps the identity response onto its legacy
 * ContactChannelRow shape.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import "./test-preload.js";

type IpcCall = { method: string; params?: Record<string, unknown> };

const ipc = {
  calls: [] as IpcCall[],
  responder: (_method: string, _params?: Record<string, unknown>): unknown =>
    ({}),
  reset(): void {
    this.calls = [];
    this.responder = () => ({});
  },
};

mock.module("../ipc/assistant-client.js", () => ({
  IpcHandlerError: class extends Error {},
  IpcTransportError: class extends Error {},
  ipcCallAssistant: mock(
    async (method: string, params?: Record<string, unknown>) => {
      ipc.calls.push({ method, params });
      return ipc.responder(method, params);
    },
  ),
}));

const {
  fetchContactsInfoBatch,
  lookupContactChannelIdentity,
  probeContactMirror,
  listContactUserFileSlugs,
} = await import("../ipc/contacts-info-client.js");
const { findContactChannelByAddress } = await import(
  "../verification/contact-helpers.js"
);

beforeEach(() => {
  ipc.reset();
});

describe("fetchContactsInfoBatch", () => {
  test("short-circuits with no IPC call for empty input", async () => {
    const result = await fetchContactsInfoBatch([]);
    expect(result).toEqual([]);
    expect(ipc.calls).toHaveLength(0);
  });

  test("sends contactIds under body and returns infos", async () => {
    ipc.responder = () => ({
      infos: [
        {
          contactId: "c1",
          notes: "n",
          userFile: null,
          contactType: "human",
          assistantMetadata: null,
        },
      ],
    });
    const result = await fetchContactsInfoBatch(["c1", "c2"]);
    expect(ipc.calls[0]).toEqual({
      method: "contacts_info_batch",
      params: { body: { contactIds: ["c1", "c2"] } },
    });
    expect(result).toHaveLength(1);
    expect(result[0].contactId).toBe("c1");
  });

  test("tolerates a missing infos field", async () => {
    ipc.responder = () => ({});
    expect(await fetchContactsInfoBatch(["c1"])).toEqual([]);
  });
});

describe("lookupContactChannelIdentity", () => {
  test("passes a (type,address) selector and unwraps the channel", async () => {
    ipc.responder = () => ({
      channel: {
        id: "ch1",
        contactId: "c1",
        type: "email",
        address: "a@b.com",
        externalChatId: null,
        displayName: "Alice",
      },
    });
    const result = await lookupContactChannelIdentity({
      type: "email",
      address: "a@b.com",
    });
    expect(ipc.calls[0]).toEqual({
      method: "contact_channel_identity_lookup",
      params: { body: { type: "email", address: "a@b.com" } },
    });
    expect(result?.id).toBe("ch1");
  });

  test("passes a channelId selector and returns null for a missing channel", async () => {
    ipc.responder = () => ({ channel: null });
    const result = await lookupContactChannelIdentity({ channelId: "nope" });
    expect(ipc.calls[0].params).toEqual({ body: { channelId: "nope" } });
    expect(result).toBeNull();
  });
});

describe("probeContactMirror", () => {
  test("passes contactId and returns the probe verbatim", async () => {
    const probe = {
      exists: true,
      hasChannels: false,
      notes: null,
      userFile: null,
      contactType: "human",
      hasMetadata: false,
    };
    ipc.responder = () => probe;
    const result = await probeContactMirror("c1");
    expect(ipc.calls[0]).toEqual({
      method: "contact_mirror_probe",
      params: { body: { contactId: "c1" } },
    });
    expect(result).toEqual(probe);
  });
});

describe("listContactUserFileSlugs", () => {
  test("passes prefix and returns the slug list", async () => {
    ipc.responder = () => ({ userFiles: ["alice.md", "alice-2.md"] });
    const result = await listContactUserFileSlugs("alice");
    expect(ipc.calls[0].params).toEqual({ body: { prefix: "alice" } });
    expect(result).toEqual(["alice.md", "alice-2.md"]);
  });
});

describe("findContactChannelByAddress (caller)", () => {
  test("maps the identity response onto ContactChannelRow", async () => {
    ipc.responder = () => ({
      channel: {
        id: "ch1",
        contactId: "c1",
        type: "telegram",
        address: "addr-1",
        externalChatId: "chat-1",
        displayName: "Bob",
      },
    });
    const row = await findContactChannelByAddress("telegram", "addr-1");
    expect(row).toEqual({
      channelId: "ch1",
      contactId: "c1",
      address: "addr-1",
      externalChatId: "chat-1",
      displayName: "Bob",
    });
  });

  test("returns null when no channel matches", async () => {
    ipc.responder = () => ({ channel: null });
    expect(await findContactChannelByAddress("telegram", "gone")).toBeNull();
  });
});
