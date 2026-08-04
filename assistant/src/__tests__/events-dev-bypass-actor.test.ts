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
import { afterAll, describe, expect, mock, test } from "bun:test";

// ── Module mocks (must be set up before importing the route) ──────────────

let fakeHttpAuthDisabled = false;
let fakeGuardianPrincipalId: string | undefined = undefined;
// Set when the IO-free cache snapshot is cold but the async (gateway-backed)
// lookup would still resolve — the state the registration backfill repairs.
let fakeAsyncGuardianPrincipalId: string | undefined = undefined;

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
  resolveActorPrincipalIdForLocalGuardian: async (
    rawHeader: string | undefined,
  ) => {
    if (rawHeader !== "dev-bypass" || !fakeHttpAuthDisabled) {
      return rawHeader;
    }
    return fakeAsyncGuardianPrincipalId;
  },
}));

// ── Real imports (after mocks) ────────────────────────────────────────────

import { AssistantEventHub } from "../runtime/assistant-event-hub.js";
import { handleSubscribeAssistantEvents } from "../runtime/routes/events-routes.js";

afterAll(() => {
  mock.restore();
});

describe("events SSE registration — dev-bypass actor translation", () => {
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
    fakeAsyncGuardianPrincipalId = undefined;

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

  test("backfills the principal when the sync cache was cold but the async lookup resolves", async () => {
    // A client that connects before the guardian-delivery cache is warm
    // registers with no principal at all. Host proxies fail closed on a
    // missing target principal, so the desktop shows up in `clients list`
    // while host_bash and computer use both refuse it — for the whole life
    // of the connection, since nothing re-runs the resolution. The handler
    // retries asynchronously and fills the gap in place.
    fakeHttpAuthDisabled = true;
    fakeGuardianPrincipalId = undefined;
    fakeAsyncGuardianPrincipalId = "guardian-real-id";

    const ac = new AbortController();
    const hub = new AssistantEventHub();

    handleSubscribeAssistantEvents(
      {
        headers: {
          "x-vellum-client-id": "cold-cache-client-005",
          "x-vellum-interface-id": "macos",
          "x-vellum-actor-principal-id": "dev-bypass",
        },
        abortSignal: ac.signal,
      },
      { hub },
    );

    expect(
      hub.getActorPrincipalIdForClient("cold-cache-client-005"),
    ).toBeUndefined();

    // Let the async lookup settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(hub.getActorPrincipalIdForClient("cold-cache-client-005")).toBe(
      "guardian-real-id",
    );

    ac.abort();
  });

  test("backfill never reassigns a principal the client already registered with", async () => {
    fakeHttpAuthDisabled = true;
    fakeGuardianPrincipalId = "guardian-real-id";
    fakeAsyncGuardianPrincipalId = "some-other-principal";

    const ac = new AbortController();
    const hub = new AssistantEventHub();

    handleSubscribeAssistantEvents(
      {
        headers: {
          "x-vellum-client-id": "warm-cache-client-006",
          "x-vellum-interface-id": "macos",
          "x-vellum-actor-principal-id": "dev-bypass",
        },
        abortSignal: ac.signal,
      },
      { hub },
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(hub.getActorPrincipalIdForClient("warm-cache-client-006")).toBe(
      "guardian-real-id",
    );

    ac.abort();
  });
});
