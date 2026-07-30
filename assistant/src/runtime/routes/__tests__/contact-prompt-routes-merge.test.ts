/**
 * Unit tests for the merge-confirmation mode of the `contacts/prompt` route.
 *
 * Merge mode is entered by passing `mergeKeepId`/`mergeDiscardId` to
 * `handleContactPrompt`. Unlike address-entry mode (where the gateway writes
 * the contact/channel and passes ids through to `resolve_contact_prompt`),
 * merge mode has the daemon perform the write itself once the guardian
 * confirms — by delegating to `handleMergeContactsRoute`, the same relay a
 * CLI-initiated `contacts/merge` call uses.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

type IpcCall = { method: string; params?: Record<string, unknown> };

let ipcCalls: IpcCall[] = [];
let contactsById: Record<string, { id: string; displayName: string }> = {};
let mergeResult: unknown = {
  ok: true,
  contact: {
    id: "keep-1",
    displayName: "Keeper",
    contactType: "human",
    channels: [],
  },
};
let mergeError: Error | undefined;

const ipcCallPersistentMock = mock(
  async (method: string, params?: Record<string, unknown>) => {
    ipcCalls.push({ method, params });
    if (method === "contacts_get_rich") {
      const id = (params as { contactId: string }).contactId;
      const contact = contactsById[id];
      if (!contact) {
        return null;
      }
      return {
        ok: true,
        contact: {
          id: contact.id,
          displayName: contact.displayName,
          role: "contact",
          interactionCount: 0,
          createdAt: 0,
          updatedAt: 0,
          channels: [],
        },
      };
    }
    if (method === "merge_contacts") {
      if (mergeError) {
        throw mergeError;
      }
      return mergeResult;
    }
    throw new Error(`unexpected ipc method: ${method}`);
  },
);

const actualGatewayClient = await import("../../../ipc/gateway-client.js");
mock.module("../../../ipc/gateway-client.js", () => ({
  ...actualGatewayClient,
  ipcCallPersistent: ipcCallPersistentMock,
}));

let broadcastCalls: Record<string, unknown>[] = [];
const broadcastMessageMock = mock((msg: Record<string, unknown>) => {
  broadcastCalls.push(msg);
});
const actualEventHub = await import("../../assistant-event-hub.js");
mock.module("../../assistant-event-hub.js", () => ({
  ...actualEventHub,
  broadcastMessage: broadcastMessageMock,
}));

const { CONTACT_PROMPT_ROUTES } = await import("../contact-prompt-routes.js");

const promptRoute = CONTACT_PROMPT_ROUTES.find(
  (r) => r.operationId === "contacts_prompt",
)!;
const resolveRoute = CONTACT_PROMPT_ROUTES.find(
  (r) => r.operationId === "resolve_contact_prompt",
)!;

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("contacts/prompt merge mode", () => {
  beforeEach(() => {
    ipcCalls = [];
    broadcastCalls = [];
    mergeError = undefined;
    mergeResult = {
      ok: true,
      contact: {
        id: "keep-1",
        displayName: "Keeper",
        contactType: "human",
        channels: [],
      },
    };
    contactsById = {
      "keep-1": { id: "keep-1", displayName: "Keeper" },
      "discard-1": { id: "discard-1", displayName: "Discardee" },
    };
  });

  test("broadcasts mode: merge with resolved contact names, then merges on confirm", async () => {
    const promptPromise = promptRoute.handler({
      body: { mergeKeepId: "keep-1", mergeDiscardId: "discard-1" },
    }) as Promise<{ ok: boolean; contactId?: string; contact?: unknown }>;

    await flush();

    expect(broadcastCalls).toHaveLength(1);
    const broadcast = broadcastCalls[0];
    expect(broadcast.type).toBe("contact_request");
    expect(broadcast.mode).toBe("merge");
    expect(broadcast.keepId).toBe("keep-1");
    expect(broadcast.discardId).toBe("discard-1");
    expect(broadcast.keepName).toBe("Keeper");
    expect(broadcast.discardName).toBe("Discardee");
    const requestId = broadcast.requestId as string;

    const resolveResult = await resolveRoute.handler({
      body: { requestId, confirmed: true },
    });
    expect(resolveResult).toEqual({ resolved: true });

    const result = await promptPromise;
    expect(result.ok).toBe(true);
    expect(result.contactId).toBe("keep-1");
    expect(result.contact).toEqual({
      id: "keep-1",
      displayName: "Keeper",
      contactType: "human",
      channels: [],
    });

    expect(
      ipcCalls.some(
        (c) =>
          c.method === "merge_contacts" &&
          c.params?.keepId === "keep-1" &&
          c.params?.mergeId === "discard-1",
      ),
    ).toBe(true);
  });

  test("cancel (confirmed: false) resolves ok:false without calling merge_contacts", async () => {
    const promptPromise = promptRoute.handler({
      body: { mergeKeepId: "keep-1", mergeDiscardId: "discard-1" },
    }) as Promise<{ ok: boolean; error?: string }>;

    await flush();
    const requestId = broadcastCalls[0].requestId as string;

    await resolveRoute.handler({ body: { requestId, confirmed: false } });

    const result = await promptPromise;
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(ipcCalls.some((c) => c.method === "merge_contacts")).toBe(false);
  });

  test("a merge_contacts relay failure resolves ok:false with the error message", async () => {
    mergeError = new Error("Cannot merge away a guardian contact.");

    const promptPromise = promptRoute.handler({
      body: { mergeKeepId: "keep-1", mergeDiscardId: "discard-1" },
    }) as Promise<{ ok: boolean; error?: string }>;

    await flush();
    const requestId = broadcastCalls[0].requestId as string;

    await resolveRoute.handler({ body: { requestId, confirmed: true } });

    const result = await promptPromise;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Cannot merge away a guardian contact.");
  });

  test("rejects when only one of mergeKeepId/mergeDiscardId is provided", async () => {
    await expect(
      promptRoute.handler({ body: { mergeKeepId: "keep-1" } }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(broadcastCalls).toHaveLength(0);
  });

  test("rejects merging a contact with itself", async () => {
    await expect(
      promptRoute.handler({
        body: { mergeKeepId: "keep-1", mergeDiscardId: "keep-1" },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(broadcastCalls).toHaveLength(0);
  });

  test("propagates a not-found contact lookup instead of broadcasting a broken prompt", async () => {
    await expect(
      promptRoute.handler({
        body: { mergeKeepId: "keep-1", mergeDiscardId: "missing-1" },
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(broadcastCalls).toHaveLength(0);
  });

  test("address-entry mode (no merge flags) is unaffected", async () => {
    const promptPromise = promptRoute.handler({
      body: { channel: "email", role: "unknown" },
    }) as Promise<{ ok: boolean; contactId?: string }>;

    await flush();
    expect(broadcastCalls).toHaveLength(1);
    const broadcast = broadcastCalls[0];
    expect(broadcast.mode).toBeUndefined();
    const requestId = broadcast.requestId as string;

    await resolveRoute.handler({
      body: {
        requestId,
        contactId: "c1",
        channelId: "ch1",
        channelType: "email",
        address: "user@example.com",
      },
    });

    const result = await promptPromise;
    expect(result.ok).toBe(true);
    expect(result.contactId).toBe("c1");
    expect(ipcCalls.some((c) => c.method === "merge_contacts")).toBe(false);
  });
});
