import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Vault mock (must precede imports) ───────────────────────────────────────

let vault: Record<string, string>;
let vaultUnreachable: boolean;
const setCalls: Array<{ account: string; value: string }> = [];

mock.module("../../../security/secure-keys.js", () => ({
  getSecureKeyResultAsync: async (account: string) =>
    vaultUnreachable
      ? { value: undefined, unreachable: true }
      : { value: vault[account], unreachable: false },
  setSecureKeyAsync: async (account: string, value: string) => {
    setCalls.push({ account, value });
    vault[account] = value;
  },
  deleteSecureKeyAsync: async (account: string) => {
    delete vault[account];
  },
}));

// ── Real imports (after mocks) ──────────────────────────────────────────────

import { getDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { providerConnections } from "../../../persistence/schema/inference.js";
import { getConnection } from "../connections.js";
import { repairSharedCredentialSlots } from "../credential-slot-repair.js";

await initializeDb();

const LEGACY = "credential/openai-compatible/api_key";

function seedRow(name: string, credential: string): void {
  const now = Date.now();
  getDb()
    .insert(providerConnections)
    .values({
      name,
      provider: "openai-compatible",
      auth: JSON.stringify({ type: "api_key", credential }),
      baseUrl: `https://${name}.example/v1`,
      models: JSON.stringify([{ id: "model-1" }]),
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function refOf(name: string): string | undefined {
  const row = getConnection(getDb(), name);
  return row?.auth.type === "api_key" ? row.auth.credential : undefined;
}

beforeEach(() => {
  getDb().delete(providerConnections).run();
  vault = {};
  vaultUnreachable = false;
  setCalls.length = 0;
});

describe("repairSharedCredentialSlots", () => {
  test("repoints sharing rows to per-connection slots and copies the shared value", async () => {
    seedRow("openai-compatible-personal", LEGACY);
    seedRow("openai-compatible-personal-2", LEGACY);
    vault[LEGACY] = "sk-last-saved";

    await repairSharedCredentialSlots(getDb());

    expect(refOf("openai-compatible-personal")).toBe(
      "credential/openai-compatible-personal/api_key",
    );
    expect(refOf("openai-compatible-personal-2")).toBe(
      "credential/openai-compatible-personal-2/api_key",
    );
    // Behavior-preserving: each new slot holds the value the row resolved
    // through the shared slot.
    expect(vault["credential/openai-compatible-personal/api_key"]).toBe(
      "sk-last-saved",
    );
    expect(vault["credential/openai-compatible-personal-2/api_key"]).toBe(
      "sk-last-saved",
    );
  });

  test("an empty shared slot still repoints the refs without writing secrets", async () => {
    seedRow("openai-compatible-personal", LEGACY);

    await repairSharedCredentialSlots(getDb());

    expect(refOf("openai-compatible-personal")).toBe(
      "credential/openai-compatible-personal/api_key",
    );
    expect(setCalls).toEqual([]);
  });

  test("defers everything when the vault is unreachable", async () => {
    seedRow("openai-compatible-personal", LEGACY);
    vaultUnreachable = true;

    await repairSharedCredentialSlots(getDb());

    expect(refOf("openai-compatible-personal")).toBe(LEGACY);
  });

  test("leaves per-connection and custom refs untouched; idempotent", async () => {
    seedRow(
      "openai-compatible-personal",
      "credential/openai-compatible-personal/api_key",
    );
    seedRow("my-endpoint", "credential/shared-team-key/api_key");

    await repairSharedCredentialSlots(getDb());
    await repairSharedCredentialSlots(getDb());

    expect(refOf("openai-compatible-personal")).toBe(
      "credential/openai-compatible-personal/api_key",
    );
    expect(refOf("my-endpoint")).toBe("credential/shared-team-key/api_key");
    expect(setCalls).toEqual([]);
  });

  test("does not overwrite a value already present in a per-connection slot", async () => {
    seedRow("openai-compatible-personal", LEGACY);
    vault[LEGACY] = "sk-shared";
    vault["credential/openai-compatible-personal/api_key"] = "sk-already-mine";

    await repairSharedCredentialSlots(getDb());

    expect(vault["credential/openai-compatible-personal/api_key"]).toBe(
      "sk-already-mine",
    );
    expect(refOf("openai-compatible-personal")).toBe(
      "credential/openai-compatible-personal/api_key",
    );
  });
});
