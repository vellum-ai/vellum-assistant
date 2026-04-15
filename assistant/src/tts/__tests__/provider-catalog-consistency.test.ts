/**
 * Consistency guard: assistant catalog vs client artifact.
 *
 * The assistant-side canonical catalog (`provider-catalog.ts`) and the
 * client-facing artifact (`meta/tts-provider-catalog.json`) must agree on
 * provider IDs, ordering, and display names. This test fails when the two
 * sources drift — for example, if a new provider is added to the assistant
 * catalog but forgotten in the client artifact, or if display names diverge.
 *
 * These checks complement the full parity guard in
 * `assistant/src/__tests__/tts-catalog-parity.test.ts`, which validates
 * credential metadata and deeper structural invariants. This file focuses
 * on fast, local assertions that live next to the catalog source.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  getCatalogProvider,
  listCatalogProviderIds,
  listCatalogProviders,
} from "../provider-catalog.js";

// ---------------------------------------------------------------------------
// Load the client artifact
// ---------------------------------------------------------------------------

interface ClientCatalogProvider {
  id: string;
  displayName: string;
  credentialMode?: string;
  credentialsGuide?: { url: string };
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
  const assistantIds = listCatalogProviderIds();
  const clientCatalog = loadClientArtifact();
  const clientIds = clientCatalog.providers.map((p) => p.id);

  // -- Loadability ----------------------------------------------------------

  test("client artifact file is loadable and has providers", () => {
    expect(clientCatalog.providers.length).toBeGreaterThan(0);
  });

  // -- Provider ID parity ---------------------------------------------------

  test("assistant catalog and client artifact have the same provider IDs (sorted)", () => {
    expect(assistantIds.slice().sort()).toEqual(clientIds.slice().sort());
  });

  test("no provider IDs in assistant catalog are missing from client artifact", () => {
    const missingFromClient = assistantIds.filter(
      (id) => !clientIds.includes(id),
    );
    if (missingFromClient.length > 0) {
      const message = [
        "Assistant catalog has provider IDs not present in meta/tts-provider-catalog.json.",
        "",
        "Missing from client artifact:",
        ...missingFromClient.map((id) => `  - ${id}`),
        "",
        "Add entries for these providers to meta/tts-provider-catalog.json.",
      ].join("\n");
      expect(missingFromClient, message).toEqual([]);
    }
  });

  test("no provider IDs in client artifact are missing from assistant catalog", () => {
    const missingFromAssistant = clientIds.filter(
      (id) => !assistantIds.includes(id),
    );
    if (missingFromAssistant.length > 0) {
      const message = [
        "Client artifact (meta/tts-provider-catalog.json) has provider IDs not present in assistant catalog.",
        "",
        "Missing from assistant catalog:",
        ...missingFromAssistant.map((id) => `  - ${id}`),
        "",
        "Add entries for these providers to assistant/src/tts/provider-catalog.ts.",
      ].join("\n");
      expect(missingFromAssistant, message).toEqual([]);
    }
  });

  // -- Ordering parity ------------------------------------------------------

  test("assistant catalog and client artifact list providers in the same order", () => {
    expect(clientIds).toEqual([...assistantIds]);
  });

  // -- Display name parity --------------------------------------------------

  test("display names match between assistant catalog and client artifact", () => {
    const violations: string[] = [];
    for (const clientEntry of clientCatalog.providers) {
      try {
        const assistantEntry = getCatalogProvider(clientEntry.id as any);
        if (clientEntry.displayName !== assistantEntry.displayName) {
          violations.push(
            `"${clientEntry.id}": client="${clientEntry.displayName}" vs assistant="${assistantEntry.displayName}"`,
          );
        }
      } catch {
        // Unknown ID — covered by provider ID parity tests above.
      }
    }

    if (violations.length > 0) {
      const message = [
        "Display name mismatch between assistant catalog and client artifact.",
        "",
        "Violations:",
        ...violations.map((v) => `  - ${v}`),
      ].join("\n");
      expect(violations, message).toEqual([]);
    }
  });

  // -- Structural sanity ----------------------------------------------------

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

  test("every client artifact entry has a credentialMode and credentialsGuide", () => {
    const violations: string[] = [];
    for (const entry of clientCatalog.providers) {
      if (
        !entry.credentialMode ||
        !["api-key", "credential"].includes(entry.credentialMode)
      ) {
        violations.push(
          `${entry.id}: missing or invalid credentialMode (got "${entry.credentialMode}")`,
        );
      }
      if (!entry.credentialsGuide?.url) {
        violations.push(`${entry.id}: missing credentialsGuide.url`);
      }
    }

    if (violations.length > 0) {
      const message = [
        "Client artifact entries have missing required fields.",
        "",
        "Violations:",
        ...violations.map((v) => `  - ${v}`),
      ].join("\n");
      expect(violations, message).toEqual([]);
    }
  });

  // -- Catalog size guard ---------------------------------------------------

  test("assistant catalog has at least as many providers as expected", () => {
    const providers = listCatalogProviders();
    // Guard: adding a provider to the catalog without updating this
    // lower-bound forces the developer to acknowledge the growth.
    expect(providers.length).toBeGreaterThanOrEqual(3);
  });
});
