/**
 * Availability for keyless connections: none-auth is `ok` exactly where
 * dispatch succeeds — keyless catalog providers (ollama) and dual-mode
 * openai-compatible endpoints — and `unsupported_auth` for keyed catalog
 * providers, mirroring `createAdapterFromConnection`.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { providerConnections } from "../../../persistence/schema/inference.js";
import { computeConnectionAvailability } from "../connection-availability.js";

await initializeDb();

function seedConnection(opts: {
  name: string;
  provider: string;
  auth: object;
}): void {
  const now = Date.now();
  getDb()
    .insert(providerConnections)
    .values({
      name: opts.name,
      provider: opts.provider,
      auth: JSON.stringify(opts.auth),
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

beforeEach(() => {
  getDb().delete(providerConnections).run();
});

describe("computeConnectionAvailability — none auth", () => {
  test("keyless openai-compatible endpoints are ok", async () => {
    seedConnection({
      name: "local-llm",
      provider: "openai-compatible",
      auth: { type: "none" },
    });
    const availability = await computeConnectionAvailability(
      "openai-compatible",
      "local-llm",
    );
    expect(availability.status).toBe("ok");
  });

  test("keyless catalog providers (ollama) are ok", async () => {
    seedConnection({
      name: "ollama-personal",
      provider: "ollama",
      auth: { type: "none" },
    });
    const availability = await computeConnectionAvailability(
      "ollama",
      "ollama-personal",
    );
    expect(availability.status).toBe("ok");
  });

  test("keyed catalog providers stay unsupported_auth", async () => {
    seedConnection({
      name: "anthropic-personal",
      provider: "anthropic",
      auth: { type: "none" },
    });
    const availability = await computeConnectionAvailability(
      "anthropic",
      "anthropic-personal",
    );
    expect(availability.status).toBe("unsupported_auth");
  });
});
