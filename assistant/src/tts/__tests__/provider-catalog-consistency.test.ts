/**
 * Consistency guard: assistant catalog vs client artifact provider IDs.
 *
 * The assistant-side canonical catalog (`provider-catalog.ts`) and the
 * client-facing artifact (`meta/tts-provider-catalog.json`) must list
 * exactly the same set of provider IDs. This test fails if the two
 * sources drift — for example, if a new provider is added to the
 * assistant catalog but forgotten in the client artifact, or vice versa.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { listCatalogProviderIds } from "../provider-catalog.js";

// ---------------------------------------------------------------------------
// Load the client artifact
// ---------------------------------------------------------------------------

interface ClientCatalogProvider {
  id: string;
  displayName: string;
}

interface ClientCatalog {
  version: number;
  providers: ClientCatalogProvider[];
}

/**
 * Resolve the path to `meta/tts-provider-catalog.json` relative to the
 * repo root. The test file lives at
 * `assistant/src/tts/__tests__/provider-catalog-consistency.test.ts`,
 * so the repo root is four directories up.
 */
const CLIENT_ARTIFACT_PATH = resolve(
  __dirname,
  "../../../../meta/tts-provider-catalog.json",
);

function loadClientArtifact(): ClientCatalog {
  const raw = readFileSync(CLIENT_ARTIFACT_PATH, "utf-8");
  return JSON.parse(raw) as ClientCatalog;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TTS provider catalog / client artifact consistency", () => {
  const assistantIds = listCatalogProviderIds().slice().sort();
  const clientCatalog = loadClientArtifact();
  const clientIds = clientCatalog.providers.map((p) => p.id).sort();

  test("client artifact file is loadable and has providers", () => {
    expect(clientCatalog.providers.length).toBeGreaterThan(0);
  });

  test("assistant catalog and client artifact have the same provider IDs", () => {
    expect(assistantIds).toEqual(clientIds);
  });

  test("no provider IDs in assistant catalog are missing from client artifact", () => {
    const missingFromClient = assistantIds.filter(
      (id) => !clientIds.includes(id),
    );
    expect(missingFromClient).toEqual([]);
  });

  test("no provider IDs in client artifact are missing from assistant catalog", () => {
    const missingFromAssistant = clientIds.filter(
      (id) => !assistantIds.includes(id),
    );
    expect(missingFromAssistant).toEqual([]);
  });

  test("client artifact version is a positive integer", () => {
    expect(Number.isInteger(clientCatalog.version)).toBe(true);
    expect(clientCatalog.version).toBeGreaterThan(0);
  });

  test("every client artifact entry has a non-empty id and displayName", () => {
    for (const entry of clientCatalog.providers) {
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.displayName.length).toBeGreaterThan(0);
    }
  });
});
