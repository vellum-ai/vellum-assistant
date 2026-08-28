/**
 * Unit tests for the daemon `contacts_record_prompt` route.
 *
 * The route is the parked half of a guardian-confirmed contact write: it
 * broadcasts the proposal and waits. It must never write, and the promise it
 * parks must be resolvable only by the gateway's `resolve_contact_prompt`
 * callback, which is what keeps an unattended assistant from changing the
 * contact graph.
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

function routeFor(operationId: string) {
  const route = CONTACT_PROMPT_ROUTES.find(
    (r) => r.operationId === operationId,
  );
  if (!route) {
    throw new Error(`route ${operationId} not registered`);
  }
  return route;
}

const recordPrompt = routeFor("contacts_record_prompt");
const resolvePrompt = routeFor("resolve_contact_prompt");

/** The broadcast for the only prompt parked so far. */
function parkedRequestId(): string {
  const message = broadcasts.find((b) => b.type === "contact_record_request");
  expect(message).toBeDefined();
  return message!.requestId as string;
}

describe("contacts_record_prompt", () => {
  beforeEach(() => {
    broadcasts = [];
    broadcastMock.mockClear();
  });

  test("broadcasts the proposal and stays parked until the guardian answers", async () => {
    const pending = recordPrompt.handler({
      body: {
        operation: "create",
        displayName: "Alice",
        notes: "Dentist",
        label: "Add a contact",
      },
    }) as Promise<Record<string, unknown>>;

    // Settled only by the gateway callback: a bare await here would hang.
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    const message = broadcasts.find((b) => b.type === "contact_record_request");
    expect(message).toBeDefined();
    expect(message!.operation).toBe("create");
    expect(message!.displayName).toBe("Alice");
    expect(message!.notes).toBe("Dentist");
    expect(message!.label).toBe("Add a contact");
    expect(typeof message!.requestId).toBe("string");

    resolvePrompt.handler({
      body: { requestId: parkedRequestId(), contactId: "ct_new" },
    });

    expect(await pending).toEqual({ ok: true, contactId: "ct_new" });
  });

  test("carries the gateway's error back to the caller", async () => {
    const pending = recordPrompt.handler({
      body: { operation: "delete", contactId: "ct_1" },
    }) as Promise<Record<string, unknown>>;

    resolvePrompt.handler({
      body: { requestId: parkedRequestId(), error: "Cancelled by user" },
    });

    expect(await pending).toEqual({ ok: false, error: "Cancelled by user" });
  });

  test("update and delete require a contact id, and broadcast nothing without one", async () => {
    for (const operation of ["update", "delete"]) {
      broadcasts = [];
      const result = (await recordPrompt.handler({
        body: { operation, displayName: "Alice" },
      })) as Record<string, unknown>;

      expect(result.ok).toBe(false);
      expect(result.error).toBe(`contactId is required to ${operation}`);
      expect(broadcasts).toHaveLength(0);
    }
  });

  test("rejects an operation outside create/update/delete", async () => {
    expect(() =>
      recordPrompt.handler({ body: { operation: "promote" } }),
    ).toThrow();
    expect(broadcasts).toHaveLength(0);
  });

  test("a resolve for an unknown request is ignored", () => {
    expect(
      resolvePrompt.handler({
        body: { requestId: "never-parked", contactId: "ct_x" },
      }),
    ).toEqual({ resolved: false });
  });
});
