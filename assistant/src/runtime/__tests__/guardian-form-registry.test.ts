/**
 * Unit tests for the guardian-form registry.
 *
 * The registry is the rail every form-backed command parks on, so the
 * concurrency rules are tested here directly rather than only through the
 * contact forms that happen to use them today. What matters: a form is
 * answered once, a claim stops the answer deadline without ending the form,
 * and a form that nobody answers ends by telling the clients showing it.
 */

import { describe, expect, mock, test } from "bun:test";

import {
  claimGuardianForm,
  type GuardianFormClosedReason,
  hasUnclaimedGuardianForm,
  openGuardianForm,
  resolveGuardianForm,
} from "../guardian-form-registry.js";

interface TestResult {
  ok: boolean;
  error?: string;
  wrote?: string;
}

/** Open a form and hand back its requestId plus the parked promise. */
function openForm(options: { kind?: string; timeoutMs?: number } = {}) {
  const closed = mock((_id: string, _reason: GuardianFormClosedReason) => {});
  let requestId = "";
  const settled = openGuardianForm<TestResult>({
    kind: options.kind ?? "test.form",
    timeoutMs: options.timeoutMs ?? 30_000,
    meta: { verify: true },
    broadcast: {
      open: (id) => {
        requestId = id;
      },
      closed,
    },
  });
  return { requestId, settled, closed };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("openGuardianForm", () => {
  test("broadcasts the form and parks until something resolves it", async () => {
    const { requestId, settled } = openForm();
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);

    let done = false;
    void settled.then(() => {
      done = true;
    });
    await tick(10);
    expect(done).toBe(false);

    resolveGuardianForm(requestId, { ok: true, wrote: "contact-1" });
    expect(await settled).toEqual({ ok: true, wrote: "contact-1" });
  });

  test("hands the writer's own fields back to the parked call", async () => {
    const { requestId, settled } = openForm();
    resolveGuardianForm(requestId, { ok: false, error: "Cancelled by user" });
    expect(await settled).toEqual({ ok: false, error: "Cancelled by user" });
  });

  test("an unanswered form ends and tells the clients showing it", async () => {
    const { requestId, settled, closed } = openForm({ timeoutMs: 30 });

    expect(await settled).toEqual({ ok: false, error: "Prompt timed out" });
    expect(closed).toHaveBeenCalledWith(requestId, "timed_out");
  });
});

describe("claimGuardianForm", () => {
  test("only the first claim wins", async () => {
    const { requestId, settled } = openForm();

    const first = claimGuardianForm(requestId);
    const second = claimGuardianForm(requestId);

    expect(first.claimed).toBe(true);
    expect(first.settleMs).toBeGreaterThan(0);
    expect(second).toEqual({ claimed: false, reason: "already_claimed" });

    resolveGuardianForm(requestId, { ok: true });
    await settled;
  });

  test("a form nobody is holding claims as unknown", () => {
    expect(claimGuardianForm("no-such-form")).toEqual({
      claimed: false,
      reason: "unknown",
    });
  });

  test("claiming disarms the answer deadline", async () => {
    // The form is open for 30ms, and the claim lands inside that window. If the
    // claim did not swap the deadline for the settle window, the parked call
    // would report a timeout while the write it started was still running.
    const { requestId, settled, closed } = openForm({ timeoutMs: 30 });
    expect(claimGuardianForm(requestId).claimed).toBe(true);

    let done = false;
    void settled.then(() => {
      done = true;
    });
    await tick(80);

    expect(done).toBe(false);
    expect(closed).not.toHaveBeenCalled();

    resolveGuardianForm(requestId, { ok: true, wrote: "late" });
    expect(await settled).toEqual({ ok: true, wrote: "late" });
  });

  test("a resolved form cannot be claimed again", async () => {
    const { requestId, settled } = openForm();
    resolveGuardianForm(requestId, { ok: true });
    await settled;

    expect(claimGuardianForm(requestId)).toEqual({
      claimed: false,
      reason: "unknown",
    });
  });
});

describe("resolveGuardianForm", () => {
  test("retires the card as answered or cancelled", async () => {
    const answered = openForm();
    resolveGuardianForm(answered.requestId, { ok: true });
    await answered.settled;
    expect(answered.closed).toHaveBeenCalledWith(
      answered.requestId,
      "answered",
    );

    const cancelled = openForm();
    resolveGuardianForm(cancelled.requestId, { ok: false, error: "no" });
    await cancelled.settled;
    expect(cancelled.closed).toHaveBeenCalledWith(
      cancelled.requestId,
      "cancelled",
    );
  });

  test("reports that nothing was waiting for an unknown form", () => {
    expect(resolveGuardianForm("no-such-form", { ok: true })).toEqual({
      resolved: false,
    });
  });
});

describe("hasUnclaimedGuardianForm", () => {
  test("sees only the kinds it is asked about", async () => {
    const { requestId, settled } = openForm({ kind: "kind.a" });

    expect(hasUnclaimedGuardianForm(["kind.a"])).toBe(true);
    // The point of taking kinds: an open form of one kind must not block a
    // form of another, which a registry-wide sweep would do.
    expect(hasUnclaimedGuardianForm(["kind.b"])).toBe(false);
    expect(hasUnclaimedGuardianForm(["kind.b", "kind.a"])).toBe(true);

    resolveGuardianForm(requestId, { ok: true });
    await settled;
    expect(hasUnclaimedGuardianForm(["kind.a"])).toBe(false);
  });

  test("a claimed form no longer counts as open", async () => {
    const { requestId, settled } = openForm({ kind: "kind.c" });
    expect(hasUnclaimedGuardianForm(["kind.c"])).toBe(true);

    claimGuardianForm(requestId);
    // Claimed means answered: its card is gone, so the next command should not
    // be refused on account of it.
    expect(hasUnclaimedGuardianForm(["kind.c"])).toBe(false);

    resolveGuardianForm(requestId, { ok: true });
    await settled;
  });
});

describe("claiming names the form", () => {
  test("a claim for a different kind is refused", async () => {
    // An id alone does not say which form it belongs to. Without this check a
    // submission to form B could claim an open form A, run B's write, and hand
    // A's caller a result for a form it never showed.
    const { requestId, settled } = openForm({ kind: "kind.real" });

    expect(claimGuardianForm(requestId, "kind.other")).toEqual({
      claimed: false,
      reason: "wrong_kind",
    });
    // Refused, not consumed: the right caller can still claim it.
    expect(claimGuardianForm(requestId, "kind.real").claimed).toBe(true);

    resolveGuardianForm(requestId, { ok: true });
    await settled;
  });

  test("a caller that names no kind still claims, as before", async () => {
    const { requestId, settled } = openForm({ kind: "kind.real" });
    expect(claimGuardianForm(requestId).claimed).toBe(true);
    resolveGuardianForm(requestId, { ok: true });
    await settled;
  });
});
