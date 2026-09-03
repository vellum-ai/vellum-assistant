/**
 * Unit tests for the daemon `contacts_prompt` route's binding target.
 *
 * The command, not the form, decides which contact a submitted address binds
 * to. The target therefore rides both the broadcast (so the card can say where
 * the channel is going) and the parked form's meta, which is what a client too
 * old to echo it reads back through `contact_prompt_flags`.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

type Broadcast = Record<string, unknown>;

let broadcasts: Broadcast[] = [];

const broadcastMock = mock((message: Broadcast) => {
  broadcasts.push(message);
});

const actualHub = await import("../../assistant-event-hub.js");
mock.module("../../assistant-event-hub.js", () => ({
  ...actualHub,
  broadcastMessage: broadcastMock,
}));

const { CONTACT_PROMPT_ROUTES } = await import("../contact-prompt-routes.js");
const { resolveGuardianForm } = await import("../../guardian-form-registry.js");

function routeFor(operationId: string) {
  const route = CONTACT_PROMPT_ROUTES.find(
    (r) => r.operationId === operationId,
  );
  if (!route) {
    throw new Error(`route ${operationId} not registered`);
  }
  return route;
}

const addressPrompt = routeFor("contacts_prompt");
const resolvePrompt = routeFor("resolve_contact_prompt");
const promptFlags = routeFor("contact_prompt_flags");

/** The broadcast for the only prompt parked so far. */
function parkedRequest(): Broadcast {
  const message = broadcasts.find((b) => b.type === "contact_request");
  expect(message).toBeDefined();
  return message!;
}

/** Settle the parked form so the test's pending call returns. */
async function settle(pending: Promise<unknown>, requestId: string) {
  resolvePrompt.handler({ body: { requestId, contactId: "ct_1" } });
  await pending;
}

describe("contacts_prompt binding target", () => {
  beforeEach(() => {
    // A parked form outlives the test that opened it, and the handlers refuse
    // to open a second one of the same kind, so each test starts by settling
    // whatever the previous one left waiting.
    for (const broadcast of broadcasts) {
      if (typeof broadcast.requestId === "string") {
        resolveGuardianForm(broadcast.requestId, {
          ok: false,
          error: "test cleanup",
        });
      }
    }
    broadcasts = [];
    broadcastMock.mockClear();
  });

  test("broadcasts the target contact and its name", async () => {
    const pending = addressPrompt.handler({
      body: {
        channel: "email",
        contactId: "ct_1",
        contactDisplayName: "Alice",
      },
    }) as Promise<Record<string, unknown>>;

    const message = parkedRequest();
    expect(message.contactId).toBe("ct_1");
    expect(message.contactDisplayName).toBe("Alice");
    expect(message.displayName).toBeUndefined();
    expect(message.notes).toBeUndefined();

    await settle(pending, message.requestId as string);
  });

  test("broadcasts a proposed name and notes for a contact to create", async () => {
    const pending = addressPrompt.handler({
      body: { channel: "email", displayName: "Bob", notes: "Plumber" },
    }) as Promise<Record<string, unknown>>;

    const message = parkedRequest();
    expect(message.displayName).toBe("Bob");
    expect(message.notes).toBe("Plumber");
    expect(message.contactId).toBeUndefined();

    await settle(pending, message.requestId as string);
  });

  test("a plain prompt carries no target at all", async () => {
    const pending = addressPrompt.handler({
      body: { channel: "email" },
    }) as Promise<Record<string, unknown>>;

    const message = parkedRequest();
    for (const key of [
      "contactId",
      "contactDisplayName",
      "displayName",
      "notes",
    ]) {
      expect(message[key]).toBeUndefined();
    }

    // And the gateway reads back only the verify flag, so an untargeted
    // submission still resolves by address the way it always has.
    expect(
      promptFlags.handler({ body: { requestId: message.requestId } }),
    ).toEqual({ known: true, verify: false });

    await settle(pending, message.requestId as string);
  });

  test("the gateway reads the target back off the parked form", async () => {
    const pending = addressPrompt.handler({
      body: { channel: "email", contactId: "ct_1", verify: true },
    }) as Promise<Record<string, unknown>>;
    const requestId = parkedRequest().requestId as string;

    // Read from the daemon rather than the submission, so a client that
    // predates the field still binds where the command said.
    expect(promptFlags.handler({ body: { requestId } })).toEqual({
      known: true,
      verify: true,
      contactId: "ct_1",
    });

    await settle(pending, requestId);
  });

  test("the proposed name and notes are parked too", async () => {
    const pending = addressPrompt.handler({
      body: { channel: "email", displayName: "Bob", notes: "Plumber" },
    }) as Promise<Record<string, unknown>>;
    const requestId = parkedRequest().requestId as string;

    expect(promptFlags.handler({ body: { requestId } })).toEqual({
      known: true,
      verify: false,
      displayName: "Bob",
      notes: "Plumber",
    });

    await settle(pending, requestId);
  });

  test("a form this process never parked reads back as unknown", () => {
    // A restart between the gateway's claim and this read leaves the target
    // unreadable rather than absent, and the gateway refuses the write rather
    // than resolving the address itself.
    expect(promptFlags.handler({ body: { requestId: "req-gone" } })).toEqual({
      known: false,
      verify: false,
    });
  });

  test("naming a contact and proposing a new one is refused, and opens no form", async () => {
    const result = (await addressPrompt.handler({
      body: { channel: "email", contactId: "ct_1", displayName: "Bob" },
    })) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("contactId");
    expect(String(result.error)).toContain("displayName");
    expect(broadcasts).toHaveLength(0);
  });

  test("a second address form is refused while one is unanswered", async () => {
    // Clients hold one contact card, so a second broadcast would replace the
    // first and strand the command parked on it.
    void addressPrompt.handler({ body: { channel: "email" } });
    expect(broadcasts).toHaveLength(1);

    const result = (await addressPrompt.handler({
      body: { channel: "phone" },
    })) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain(
      "Another contact form is already open",
    );
    expect(broadcasts).toHaveLength(1);
  });

  test("a pending record form does not block an address form", async () => {
    // Clients hold the two contact cards in separate slots and render both, so
    // only a second card of the same kind replaces one.
    const recordPrompt = routeFor("contacts_record_prompt");
    void recordPrompt.handler({
      body: { operation: "delete", contactId: "ct_9" },
    });

    const result = (await Promise.race([
      addressPrompt.handler({ body: { channel: "email" } }),
      new Promise((resolve) => setTimeout(() => resolve("parked"), 50)),
    ])) as unknown;

    // Parking is the success signal here: a refusal would settle immediately.
    expect(result).toBe("parked");
    expect(broadcasts.filter((b) => b.type === "contact_request")).toHaveLength(
      1,
    );
  });

  test("naming a contact and proposing notes is refused, and opens no form", async () => {
    // A targeted bind writes no record, so notes riding along would be
    // reported as saved and dropped.
    const result = (await addressPrompt.handler({
      body: { channel: "email", contactId: "ct_1", notes: "Met at the talk" },
    })) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("contactId");
    expect(String(result.error)).toContain("notes");
    expect(broadcasts).toHaveLength(0);
  });
});
