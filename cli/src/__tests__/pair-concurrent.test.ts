/**
 * Tests that the /pair command rejects a second pairing registration
 * while one is already in progress (status: registered or pending).
 *
 * The CLI's /pair handler generates a fresh pairingRequestId each time
 * and POSTs to /pairing/register on the runtime. The runtime should
 * reject the second registration when an active (non-terminal) pairing
 * request already exists.
 */

import { randomBytes, randomUUID } from "crypto";
import { describe, test, expect, afterEach } from "bun:test";

// ---------------------------------------------------------------------------
// Helpers – simulate the CLI's /pair registration call
// ---------------------------------------------------------------------------

interface RegisterParams {
  pairingRequestId: string;
  pairingSecret: string;
  gatewayUrl: string;
}

function buildRegisterParams(gatewayUrl: string): RegisterParams {
  return {
    pairingRequestId: randomUUID(),
    pairingSecret: randomBytes(32).toString("hex"),
    gatewayUrl,
  };
}

async function registerPairing(
  serverUrl: string,
  params: RegisterParams,
): Promise<Response> {
  return fetch(`${serverUrl}/pairing/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

// ---------------------------------------------------------------------------
// Mock runtime server — mirrors the real runtime's PairingStore.register()
// behaviour so the test demonstrates the actual bug.
//
// The real PairingStore.register() only checks for ID collisions (same ID,
// different secret). It does NOT check whether another pairing request is
// already active. Each /pair invocation generates a new UUID, so the
// collision check never fires and multiple concurrent registrations succeed.
// ---------------------------------------------------------------------------

type PairingStatus = "registered" | "pending" | "approved" | "denied" | "expired";

interface StoredPairing {
  pairingRequestId: string;
  pairingSecret: string;
  status: PairingStatus;
}

function createMockRuntimeServer() {
  const pairings = new Map<string, StoredPairing>();

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/pairing/register" && req.method === "POST") {
        const body = (await req.json()) as Record<string, unknown>;
        const pairingRequestId = String(body.pairingRequestId ?? "");
        const pairingSecret = String(body.pairingSecret ?? "");
        const gatewayUrl = String(body.gatewayUrl ?? "");

        if (!pairingRequestId || !pairingSecret || !gatewayUrl) {
          return Response.json(
            { error: { code: "BAD_REQUEST", message: "Missing required fields" } },
            { status: 400 },
          );
        }

        // --- Real PairingStore.register() logic (verbatim) ---
        // Only rejects when the same ID exists with a different secret.
        const existing = pairings.get(pairingRequestId);
        if (existing && existing.pairingSecret !== pairingSecret) {
          return Response.json(
            { error: { code: "CONFLICT", message: "Conflict: pairingRequestId exists with different secret" } },
            { status: 409 },
          );
        }

        pairings.set(pairingRequestId, {
          pairingRequestId,
          pairingSecret,
          status: "registered",
        });

        return Response.json({ ok: true });
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });

  return { server, pairings };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("/pair — concurrent registration guard", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let pairings: Map<string, StoredPairing> | null = null;

  afterEach(() => {
    if (server) {
      server.stop(true);
      server = null;
    }
    pairings = null;
  });

  test("rejects a second /pair registration while one is already in progress", async () => {
    /**
     * Tests that the runtime rejects a second pairing registration when
     * an active (registered/pending) pairing request already exists.
     */

    const mock = createMockRuntimeServer();
    server = mock.server;
    pairings = mock.pairings;
    const serverUrl = `http://localhost:${server.port}`;

    // GIVEN a first /pair command has been issued and a pairing is registered
    const firstParams = buildRegisterParams(serverUrl);
    const firstRes = await registerPairing(serverUrl, firstParams);
    expect(firstRes.status).toBe(200);
    const firstBody = (await firstRes.json()) as { ok: boolean };
    expect(firstBody.ok).toBe(true);

    // AND the first pairing is still in progress (not yet approved/denied/expired)
    expect(pairings!.get(firstParams.pairingRequestId)?.status).toBe("registered");

    // WHEN a second /pair command is issued (different pairingRequestId, as the
    // CLI always generates a fresh UUID)
    const secondParams = buildRegisterParams(serverUrl);
    const secondRes = await registerPairing(serverUrl, secondParams);

    // THEN the second registration should be rejected because one is already active
    expect(secondRes.status).toBe(409);
  });
});
