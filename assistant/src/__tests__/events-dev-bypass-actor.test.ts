/**
 * Regression tests for the SSE registration dev-bypass actor principal
 * translation.
 *
 * In `DISABLE_HTTP_AUTH=true` (platform-managed) deployments the synthetic
 * dev-bypass `AuthContext` injects `actorPrincipalId="dev-bypass"` for every
 * request. Trust resolution still resolves to the real local guardian's
 * principalId via `resolveLocalPrincipalTrustContext`. Without translation,
 * `ClientEntry.actorPrincipalId === "dev-bypass"` and
 * `ToolContext.sourceActorPrincipalId === "<real-guardian>"` mismatch, so the
 * same-user check in HostBashProxy / HostFileProxy / HostCuProxy /
 * conversation-surfaces rejects every targeted host proxy invocation and the
 * auto-resolve path silently falls through to untargeted broadcast.
 *
 * The events-routes handler translates `"dev-bypass"` to the real guardian's
 * principalId at registration time so both sides agree. This keeps targeted
 * host proxy execution working on Docker / platform-managed deployments.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks (must be set up before importing the route) ──────────────

let fakeHttpAuthDisabled = false;
let fakeGuardianPrincipalId: string | undefined = undefined;

// Manually-resolvable async resolutions, in call order, so tests control
// exactly when the SSE self-heal lookup completes.
const pendingAsyncResolutions: Array<(value: string | undefined) => void> = [];

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => fakeHttpAuthDisabled,
  hasUngatedHttpAuthDisabled: () => false,
}));

mock.module("../runtime/local-actor-identity.js", () => ({
  findLocalGuardianPrincipalIdFromStore: () => fakeGuardianPrincipalId,
  resolveActorPrincipalIdForLocalGuardianSync: (
    rawHeader: string | undefined,
  ) => {
    if (rawHeader !== "dev-bypass" || !fakeHttpAuthDisabled) {
      return rawHeader;
    }
    return fakeGuardianPrincipalId;
  },
  resolveActorPrincipalIdForLocalGuardian: (rawHeader: string | undefined) => {
    if (rawHeader !== "dev-bypass" || !fakeHttpAuthDisabled) {
      return Promise.resolve(rawHeader);
    }
    return new Promise<string | undefined>((resolve) => {
      pendingAsyncResolutions.push(resolve);
    });
  },
}));

/** Let the fire-and-forget heal promise chain settle. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ── Real imports (after mocks) ────────────────────────────────────────────

import { AssistantEventHub } from "../runtime/assistant-event-hub.js";
import { handleSubscribeAssistantEvents } from "../runtime/routes/events-routes.js";

afterAll(() => {
  mock.restore();
});

describe("events SSE registration — dev-bypass actor translation", () => {
  beforeEach(() => {
    pendingAsyncResolutions.length = 0;
  });

  test("translates 'dev-bypass' to the real guardian principalId when auth is disabled", () => {
    fakeHttpAuthDisabled = true;
    fakeGuardianPrincipalId = "guardian-real-id";

    const ac = new AbortController();
    const hub = new AssistantEventHub();

    handleSubscribeAssistantEvents(
      {
        headers: {
          "x-vellum-client-id": "devbypass-client-001",
          "x-vellum-interface-id": "macos",
          "x-vellum-actor-principal-id": "dev-bypass",
        },
        abortSignal: ac.signal,
      },
      { hub },
    );

    const entry = hub.getClientById("devbypass-client-001");
    expect(entry?.actorPrincipalId).toBe("guardian-real-id");
    expect(hub.getActorPrincipalIdForClient("devbypass-client-001")).toBe(
      "guardian-real-id",
    );

    ac.abort();
  });

  test("registers without principalId when dev-bypass is set but no guardian is bound", () => {
    fakeHttpAuthDisabled = true;
    fakeGuardianPrincipalId = undefined;

    const ac = new AbortController();
    const hub = new AssistantEventHub();

    handleSubscribeAssistantEvents(
      {
        headers: {
          "x-vellum-client-id": "devbypass-client-002",
          "x-vellum-interface-id": "macos",
          "x-vellum-actor-principal-id": "dev-bypass",
        },
        abortSignal: ac.signal,
      },
      { hub },
    );

    const entry = hub.getClientById("devbypass-client-002");
    expect(entry).toBeDefined();
    expect(entry?.actorPrincipalId).toBeUndefined();

    ac.abort();
  });

  test("self-heals a cold-cache registration once the async guardian lookup resolves", async () => {
    fakeHttpAuthDisabled = true;
    fakeGuardianPrincipalId = undefined; // cold cache: sync resolution misses

    const ac = new AbortController();
    const hub = new AssistantEventHub();

    handleSubscribeAssistantEvents(
      {
        headers: {
          "x-vellum-client-id": "heal-client-001",
          "x-vellum-interface-id": "chrome-extension",
          "x-vellum-actor-principal-id": "dev-bypass",
        },
        abortSignal: ac.signal,
      },
      { hub },
    );

    // Registered without a principal, heal lookup in flight.
    expect(hub.getActorPrincipalIdForClient("heal-client-001")).toBeUndefined();
    expect(pendingAsyncResolutions).toHaveLength(1);

    pendingAsyncResolutions.shift()!("guardian-real-id");
    await flushMicrotasks();

    // Hub record patched: a host-proxy request registered now snapshots the
    // real principal, so the result-route same-actor check passes.
    expect(hub.getActorPrincipalIdForClient("heal-client-001")).toBe(
      "guardian-real-id",
    );

    ac.abort();
  });

  test("does not start the heal lookup when the sync resolution already succeeded", () => {
    fakeHttpAuthDisabled = true;
    fakeGuardianPrincipalId = "guardian-real-id"; // warm cache

    const ac = new AbortController();
    const hub = new AssistantEventHub();

    handleSubscribeAssistantEvents(
      {
        headers: {
          "x-vellum-client-id": "warm-client-001",
          "x-vellum-interface-id": "macos",
          "x-vellum-actor-principal-id": "dev-bypass",
        },
        abortSignal: ac.signal,
      },
      { hub },
    );

    expect(pendingAsyncResolutions).toHaveLength(0);

    ac.abort();
  });

  test("does not start the heal lookup for connections without a dev-bypass principal", () => {
    fakeHttpAuthDisabled = true;
    fakeGuardianPrincipalId = undefined;

    const ac = new AbortController();
    const hub = new AssistantEventHub();

    // Legacy connection with no actor-principal header at all: it registers
    // without a principal and must stay that way (no dev-bypass translation).
    handleSubscribeAssistantEvents(
      {
        headers: {
          "x-vellum-client-id": "legacy-client-001",
          "x-vellum-interface-id": "macos",
        },
        abortSignal: ac.signal,
      },
      { hub },
    );

    expect(pendingAsyncResolutions).toHaveLength(0);
    expect(
      hub.getActorPrincipalIdForClient("legacy-client-001"),
    ).toBeUndefined();

    ac.abort();
  });

  test("a stale heal cannot patch the subscription that replaced it (reconnect race)", async () => {
    fakeHttpAuthDisabled = true;
    fakeGuardianPrincipalId = undefined; // cold cache for the first connect

    const ac1 = new AbortController();
    const hub = new AssistantEventHub();

    handleSubscribeAssistantEvents(
      {
        headers: {
          "x-vellum-client-id": "race-client-001",
          "x-vellum-interface-id": "macos",
          "x-vellum-actor-principal-id": "dev-bypass",
        },
        abortSignal: ac1.signal,
      },
      { hub },
    );
    expect(pendingAsyncResolutions).toHaveLength(1);
    const staleHeal = pendingAsyncResolutions.shift()!;

    // Client reconnects before the first heal resolves; cache is warm now.
    fakeGuardianPrincipalId = "guardian-current";
    const ac2 = new AbortController();
    handleSubscribeAssistantEvents(
      {
        headers: {
          "x-vellum-client-id": "race-client-001",
          "x-vellum-interface-id": "macos",
          "x-vellum-actor-principal-id": "dev-bypass",
        },
        abortSignal: ac2.signal,
      },
      { hub },
    );

    // The stale heal resolves late with a different value; it is keyed to
    // the disposed connection, so the live record must be untouched.
    staleHeal("guardian-stale");
    await flushMicrotasks();

    expect(hub.getActorPrincipalIdForClient("race-client-001")).toBe(
      "guardian-current",
    );

    ac1.abort();
    ac2.abort();
  });

  test("fillClientActorPrincipalId never overwrites a present principal", () => {
    const hub = new AssistantEventHub();
    const sub = hub.subscribe({
      type: "client",
      clientId: "direct-client-001",
      interfaceId: "macos",
      capabilities: [],
      actorPrincipalId: "existing-principal",
      callback: () => {},
    });

    hub.fillClientActorPrincipalId(sub.connectionId, "other-principal");
    expect(hub.getActorPrincipalIdForClient("direct-client-001")).toBe(
      "existing-principal",
    );

    // Unknown connection id is a no-op.
    hub.fillClientActorPrincipalId("conn-does-not-exist", "other-principal");
    expect(hub.getActorPrincipalIdForClient("direct-client-001")).toBe(
      "existing-principal",
    );

    sub.dispose();
  });

  test("does NOT translate when auth is enabled (production mode)", () => {
    // Defense in depth: make sure we never silently rewrite a real
    // principalId that legitimately happens to be the literal "dev-bypass"
    // string in a non-dev-bypass deployment. The translation is gated on
    // isHttpAuthDisabled() === true.
    fakeHttpAuthDisabled = false;
    fakeGuardianPrincipalId = "guardian-real-id";

    const ac = new AbortController();
    const hub = new AssistantEventHub();

    handleSubscribeAssistantEvents(
      {
        headers: {
          "x-vellum-client-id": "prod-client-003",
          "x-vellum-interface-id": "macos",
          "x-vellum-actor-principal-id": "dev-bypass",
        },
        abortSignal: ac.signal,
      },
      { hub },
    );

    const entry = hub.getClientById("prod-client-003");
    expect(entry?.actorPrincipalId).toBe("dev-bypass");

    ac.abort();
  });

  test("passes through non-dev-bypass principalId verbatim in dev-bypass mode", () => {
    // Edge case: a service-token connection that happens to be made while
    // the daemon runs in DISABLE_HTTP_AUTH=true mode should still register
    // with its own principalId, not the guardian's.
    fakeHttpAuthDisabled = true;
    fakeGuardianPrincipalId = "guardian-real-id";

    const ac = new AbortController();
    const hub = new AssistantEventHub();

    handleSubscribeAssistantEvents(
      {
        headers: {
          "x-vellum-client-id": "service-client-004",
          "x-vellum-interface-id": "macos",
          "x-vellum-actor-principal-id": "service-account-A",
        },
        abortSignal: ac.signal,
      },
      { hub },
    );

    const entry = hub.getClientById("service-client-004");
    expect(entry?.actorPrincipalId).toBe("service-account-A");

    ac.abort();
  });
});
