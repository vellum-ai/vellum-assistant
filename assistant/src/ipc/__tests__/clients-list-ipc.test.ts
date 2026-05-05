/**
 * End-to-end test for `assistant clients list` over IPC.
 *
 * Regression test for the gap where the same-user filter on
 * `GET /v1/clients` (which reads `headers["x-vellum-actor-principal-id"]`)
 * silently returned an empty list over IPC because the IPC adapter did
 * not inject the synthetic actor-principal header that the HTTP adapter
 * populates from the verified `AuthContext`.
 *
 * Asserts that in non-dev-bypass mode (`isHttpAuthDisabled() === false`),
 * the CLI sees same-user clients via the IPC path because the IPC server
 * fills in the header from the local guardian principal.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { runAssistantCommandFull } from "../../cli/__tests__/run-assistant-command.js";
import { AssistantIpcServer } from "../assistant-server.js";

// ── Module mocks (must be set up before importing the route) ──────────────

let fakeHttpAuthDisabled = false;
let fakeLocalPrincipalId: string | undefined = "guardian-local";

mock.module("../../config/env.js", () => ({
  isHttpAuthDisabled: () => fakeHttpAuthDisabled,
  hasUngatedHttpAuthDisabled: () => false,
}));

mock.module("../../runtime/local-actor-identity.js", () => ({
  findLocalGuardianPrincipalId: () => fakeLocalPrincipalId,
}));

// ── Real imports (after mocks) ────────────────────────────────────────────

import { assistantEventHub } from "../../runtime/assistant-event-hub.js";

// ── Fixtures ──────────────────────────────────────────────────────────────

let server: AssistantIpcServer | null = null;

function registerClient(args: {
  clientId: string;
  actorPrincipalId?: string;
}): void {
  assistantEventHub.subscribe({
    type: "client",
    clientId: args.clientId,
    interfaceId: "macos",
    capabilities: ["host_bash", "host_file", "host_cu"],
    actorPrincipalId: args.actorPrincipalId,
    callback: () => {},
  });
}

function clearHub(): void {
  const ids = assistantEventHub.listClients().map((c) => c.clientId);
  for (const id of ids) {
    assistantEventHub.disposeClient(id);
  }
}

async function startServer(): Promise<void> {
  server = new AssistantIpcServer();
  await server.start();
  // Allow the listener to be ready before the CLI tries to connect.
  await new Promise((resolve) => setTimeout(resolve, 50));
}

beforeEach(() => {
  fakeHttpAuthDisabled = false;
  fakeLocalPrincipalId = "guardian-local";
  clearHub();
});

afterEach(() => {
  server?.stop();
  server = null;
});

afterAll(() => {
  mock.restore();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe("assistant clients list over IPC — same-user filter", () => {
  test("returns same-user clients in non-dev-bypass mode", async () => {
    registerClient({
      clientId: "client-self-1",
      actorPrincipalId: "guardian-local",
    });
    registerClient({
      clientId: "client-self-2",
      actorPrincipalId: "guardian-local",
    });
    registerClient({
      clientId: "client-other",
      actorPrincipalId: "other-user",
    });

    await startServer();

    const { stdout } = await runAssistantCommandFull(
      "clients",
      "list",
      "--json",
    );

    const parsed = JSON.parse(stdout.trim()) as {
      clients: Array<{ clientId: string }>;
    };
    const ids = parsed.clients.map((c) => c.clientId).sort();
    expect(ids).toEqual(["client-self-1", "client-self-2"]);
  });

  test("returns empty when no local guardian principal is bound (fail-closed)", async () => {
    fakeLocalPrincipalId = undefined;
    registerClient({
      clientId: "client-self",
      actorPrincipalId: "guardian-local",
    });

    await startServer();

    const { stdout } = await runAssistantCommandFull(
      "clients",
      "list",
      "--json",
    );
    const parsed = JSON.parse(stdout.trim()) as {
      clients: Array<{ clientId: string }>;
    };
    expect(parsed.clients).toEqual([]);
  });

  test("dev-bypass mode returns all clients regardless of principal", async () => {
    fakeHttpAuthDisabled = true;
    registerClient({
      clientId: "client-self",
      actorPrincipalId: "guardian-local",
    });
    registerClient({
      clientId: "client-other",
      actorPrincipalId: "other-user",
    });

    await startServer();

    const { stdout } = await runAssistantCommandFull(
      "clients",
      "list",
      "--json",
    );
    const parsed = JSON.parse(stdout.trim()) as {
      clients: Array<{ clientId: string }>;
    };
    const ids = parsed.clients.map((c) => c.clientId).sort();
    expect(ids).toEqual(["client-other", "client-self"]);
  });
});
