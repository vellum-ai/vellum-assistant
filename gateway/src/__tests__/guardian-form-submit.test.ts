/**
 * Tests for the write half of the guardian-form rail.
 *
 * These pin the parts every form depends on and none of them implements: the
 * claim is taken before the write, a client that lost the race is told
 * something it can act on, and every outcome reports back so the parked
 * command never hangs on a write that already happened.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

interface IpcCall {
  method: string;
  body: Record<string, unknown>;
}

let calls: IpcCall[] = [];
let claimAnswer: Record<string, unknown> = { claimed: true, settleMs: 5_000 };
let claimThrows = false;

const ipcMock = mock(
  async (method: string, options?: { body?: Record<string, unknown> }) => {
    calls.push({ method, body: options?.body ?? {} });
    if (method.includes("claim")) {
      if (claimThrows) {
        throw new Error("socket closed");
      }
      return claimAnswer;
    }
    return { resolved: true };
  },
);

const actualAssistantClient = await import("../ipc/assistant-client.js");
mock.module("../ipc/assistant-client.js", () => ({
  ...actualAssistantClient,
  ipcCallAssistant: ipcMock,
}));

const { submitGuardianForm } =
  await import("../http/routes/guardian-form-submit.js");

const resolveCall = () => calls.find((c) => c.method.includes("resolve"));

beforeEach(() => {
  calls = [];
  claimAnswer = { claimed: true, settleMs: 5_000 };
  claimThrows = false;
});

describe("submitGuardianForm", () => {
  test("claims before writing, then reports the writer's fields", async () => {
    const order: string[] = [];
    ipcMock.mockImplementationOnce(async (method: string) => {
      order.push(method);
      return { claimed: true, settleMs: 5_000 };
    });

    const res = await submitGuardianForm({
      requestId: "req-1",
      write: async () => {
        order.push("write");
        return { resolution: { id: "row-7", rows: 3 } };
      },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true });
    expect(order).toEqual(["guardian_form_claim", "write"]);
    expect(resolveCall()?.body).toEqual({
      requestId: "req-1",
      id: "row-7",
      rows: 3,
    });
  });

  test("the rail's requestId survives a result that carries its own", async () => {
    // A form whose result happened to carry `requestId` would otherwise
    // redirect its own callback, and its caller would time out over a write
    // that committed.
    await submitGuardianForm({
      requestId: "req-real",
      write: async () => ({
        resolution: { requestId: "req-somebody-else", id: "row-1" },
      }),
    });

    expect(resolveCall()?.body.requestId).toBe("req-real");
  });

  test("a dismissal reports without running the write", async () => {
    const write = mock(async () => ({ resolution: {} }));

    const res = await submitGuardianForm({
      requestId: "req-2",
      cancelled: true,
    });

    expect(res.status).toBe(200);
    expect(write).not.toHaveBeenCalled();
    expect(resolveCall()?.body).toEqual({
      requestId: "req-2",
      error: "Cancelled by user",
      cancelled: true,
    });
  });

  test("a write's resolution carries no cancellation marker", async () => {
    await submitGuardianForm({
      requestId: "req-2b",
      write: async () => ({ resolution: { contactId: "c1" } }),
    });

    expect(resolveCall()?.body).not.toHaveProperty("cancelled");
  });

  test("a failure the writer classified keeps its own status", async () => {
    const res = await submitGuardianForm({
      requestId: "req-3",
      write: async () => ({
        failure: { error: "Contact not found", status: 404 },
      }),
    });

    expect(res.status).toBe(404);
    expect(resolveCall()?.body).toEqual({
      requestId: "req-3",
      error: "Contact not found",
    });
  });

  test("a write that throws still reports, so the command does not hang", async () => {
    const res = await submitGuardianForm({
      requestId: "req-4",
      write: async () => {
        throw new Error("unexpected");
      },
    });

    expect(res.status).toBe(500);
    expect(resolveCall()?.body).toEqual({
      requestId: "req-4",
      error: "The write failed",
    });
  });

  test("losing the claim to another client reads as success, and writes nothing", async () => {
    claimAnswer = { claimed: false, reason: "already_claimed" };
    const write = mock(async () => ({ resolution: {} }));

    const res = await submitGuardianForm({ requestId: "req-5", write });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true, duplicate: true });
    expect(write).not.toHaveBeenCalled();
    expect(resolveCall()).toBeUndefined();
  });

  test("an unreachable assistant is a 503 the client can retry", async () => {
    claimThrows = true;
    const write = mock(async () => ({ resolution: {} }));

    const res = await submitGuardianForm({ requestId: "req-6", write });

    expect(res.status).toBe(503);
    expect(write).not.toHaveBeenCalled();
  });

  test("a form nobody is waiting on is a 409", async () => {
    claimAnswer = { claimed: false, reason: "unknown" };

    const res = await submitGuardianForm({
      requestId: "req-7",
      write: async () => ({ resolution: {} }),
    });

    expect(res.status).toBe(409);
  });

  test("a form can pin its own callback operations", async () => {
    await submitGuardianForm({
      requestId: "req-8",
      claimOperation: "contact_prompt_claim",
      resolveOperation: "resolve_contact_prompt",
      write: async () => ({ resolution: { contactId: "c1" } }),
    });

    expect(calls.map((c) => c.method)).toEqual([
      "contact_prompt_claim",
      "resolve_contact_prompt",
    ]);
  });
});

describe("reserved result keys", () => {
  test("a stray error on a success does not become a cancellation", async () => {
    // resolveFormFromCallback reads any truthy `error` as a failure, so a
    // result carrying its own would report a cancellation over a write that
    // committed, and drop the rest of the result with it.
    await submitGuardianForm({
      requestId: "req-9",
      write: async () => ({
        resolution: { error: "a field of my own", id: "row-2" },
      }),
    });

    expect(resolveCall()?.body).toEqual({ requestId: "req-9", id: "row-2" });
  });

  test("the form it is writing for is named on the claim", async () => {
    await submitGuardianForm({
      requestId: "req-10",
      formKind: "my.form",
      write: async () => ({ resolution: {} }),
    });

    expect(calls[0]).toEqual({
      method: "guardian_form_claim",
      body: { requestId: "req-10", kind: "my.form" },
    });
  });
});
