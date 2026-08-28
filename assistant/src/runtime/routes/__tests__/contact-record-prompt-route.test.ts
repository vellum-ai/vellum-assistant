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
const claimPrompt = routeFor("contact_prompt_claim");

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

    // Every client saw this form, so every client is told it is over.
    expect(
      broadcasts.find((b) => b.type === "contact_form_closed"),
    ).toMatchObject({ reason: "answered" });
  });

  test("a dismissal closes the form on the clients that did not dismiss it", async () => {
    const pending = recordPrompt.handler({
      body: { operation: "create", displayName: "Alice" },
    }) as Promise<Record<string, unknown>>;
    const requestId = parkedRequestId();

    resolvePrompt.handler({
      body: { requestId, error: "Cancelled by user" },
    });
    await pending;

    expect(
      broadcasts.find((b) => b.type === "contact_form_closed"),
    ).toMatchObject({ requestId, reason: "cancelled" });
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

  test("only the first claim on a form is granted", async () => {
    const pending = recordPrompt.handler({
      body: { operation: "create", displayName: "Alice" },
    }) as Promise<Record<string, unknown>>;
    const requestId = parkedRequestId();

    // Two clients answering the same broadcast. The daemon holds the only
    // record of which forms are open, so it is what settles the race.
    // A granted claim carries the window its write has to report back in.
    expect(claimPrompt.handler({ body: { requestId } })).toMatchObject({
      claimed: true,
      settleMs: expect.any(Number),
    });
    expect(claimPrompt.handler({ body: { requestId } })).toEqual({
      claimed: false,
      reason: "already_claimed",
    });

    resolvePrompt.handler({ body: { requestId, contactId: "ct_new" } });
    await pending;
  });

  test("a claim on a form nobody is waiting on is refused as unknown", () => {
    expect(
      claimPrompt.handler({ body: { requestId: "never-parked" } }),
    ).toEqual({
      claimed: false,
      reason: "unknown",
    });
  });

  test("a resolved form can no longer be claimed", async () => {
    const pending = recordPrompt.handler({
      body: { operation: "create", displayName: "Alice" },
    }) as Promise<Record<string, unknown>>;
    const requestId = parkedRequestId();

    claimPrompt.handler({ body: { requestId } });
    resolvePrompt.handler({ body: { requestId, contactId: "ct_new" } });
    await pending;

    // The entry is gone once the call it was holding has returned, so a late
    // submission has nothing to write for.
    expect(claimPrompt.handler({ body: { requestId } })).toEqual({
      claimed: false,
      reason: "unknown",
    });
  });

  test("the caller's timeout is what closes the form", async () => {
    const pending = recordPrompt.handler({
      body: { operation: "create", displayName: "Alice", timeoutMs: 60 },
    }) as Promise<Record<string, unknown>>;
    const requestId = parkedRequestId();

    // A form that outlived the command that opened it could still be answered,
    // writing something the caller was already told had failed.
    expect(await pending).toEqual({ ok: false, error: "Prompt timed out" });

    // And it is gone, so a late answer has nothing to claim.
    expect(claimPrompt.handler({ body: { requestId } })).toEqual({
      claimed: false,
      reason: "unknown",
    });

    // Clients are told, so the card comes down rather than offering to submit
    // an answer that would now be refused.
    expect(
      broadcasts.find((b) => b.type === "contact_form_closed"),
    ).toMatchObject({ requestId, reason: "timed_out" });
  });

  test("claiming a form stops its deadline, so a slow write is not reported as a timeout", async () => {
    const pending = recordPrompt.handler({
      body: { operation: "delete", contactId: "ct_1", timeoutMs: 60 },
    }) as Promise<Record<string, unknown>>;
    const requestId = parkedRequestId();

    // Somebody answered right at the deadline and the write is in flight. The
    // original timer firing now would tell the caller nothing happened while
    // the delete went on to commit.
    expect(claimPrompt.handler({ body: { requestId } })).toMatchObject({
      claimed: true,
    });

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(settled).toBe(false);
    expect(broadcasts.some((b) => b.type === "contact_form_closed")).toBe(
      false,
    );

    resolvePrompt.handler({ body: { requestId, contactId: "ct_1" } });
    expect(await pending).toEqual({ ok: true, contactId: "ct_1" });
  });

  test("a second form is refused rather than replacing the first", async () => {
    const first = recordPrompt.handler({
      body: { operation: "create", displayName: "Alice" },
    }) as Promise<Record<string, unknown>>;
    const firstRequestId = parkedRequestId();

    // A client shows one contact form at a time, so a second broadcast would
    // take the first's card away and leave its command waiting on a form
    // nobody can answer.
    const second = (await recordPrompt.handler({
      body: { operation: "create", displayName: "Bob" },
    })) as Record<string, unknown>;

    expect(second.ok).toBe(false);
    expect(String(second.error)).toContain("already open");
    expect(
      broadcasts.filter((b) => b.type === "contact_record_request"),
    ).toHaveLength(1);

    resolvePrompt.handler({
      body: { requestId: firstRequestId, contactId: "ct_new" },
    });
    await first;
  });

  test("a form that has been answered does not block the next one", async () => {
    const first = recordPrompt.handler({
      body: { operation: "create", displayName: "Alice" },
    }) as Promise<Record<string, unknown>>;
    const firstRequestId = parkedRequestId();
    claimPrompt.handler({ body: { requestId: firstRequestId } });

    // Claimed means somebody answered it; its write is on its way and the
    // guardian's card is done. The next command should not be refused.
    const second = recordPrompt.handler({
      body: { operation: "create", displayName: "Bob" },
    }) as Promise<Record<string, unknown>>;

    expect(
      broadcasts.filter((b) => b.type === "contact_record_request"),
    ).toHaveLength(2);

    resolvePrompt.handler({
      body: { requestId: firstRequestId, contactId: "ct_new" },
    });
    await first;
    const secondId = (
      broadcasts.filter((b) => b.type === "contact_record_request")[1] as {
        requestId: string;
      }
    ).requestId;
    resolvePrompt.handler({ body: { requestId: secondId, contactId: "ct_2" } });
    await second;
  });

  test("a resolve for an unknown request is ignored", () => {
    expect(
      resolvePrompt.handler({
        body: { requestId: "never-parked", contactId: "ct_x" },
      }),
    ).toEqual({ resolved: false });
  });
});
