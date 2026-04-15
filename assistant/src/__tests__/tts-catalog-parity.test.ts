import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  getCatalogProvider,
  listCatalogProviderIds,
} from "../tts/provider-catalog.js";
import type { TtsProviderId } from "../tts/types.js";

/**
 * Parity guard: daemon TTS provider catalog vs client TTS catalog JSON.
 *
 * The daemon maintains its canonical provider catalog in
 * `assistant/src/tts/provider-catalog.ts`.
 * The client-facing metadata lives in `meta/tts-provider-catalog.json` and is
 * bundled into native clients at build time.
 *
 * These tests enforce that both catalogs stay in sync on the fields they
 * share: provider IDs, ordering, and credential metadata needed for client
 * key handling. CI will fail when they drift, forcing the developer to update
 * whichever side fell behind.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve repo root (tests run from assistant/) */
function getRepoRoot(): string {
  return join(process.cwd(), "..");
}

interface ClientCatalogCredentialsGuide {
  description: string;
  url: string;
  linkLabel: string;
}

interface ClientCatalogEntry {
  id: string;
  displayName: string;
  subtitle: string;
  setupMode: string;
  setupHint: string;
  credentialMode: "api-key" | "credential";
  /** Present when credentialMode is "api-key". */
  apiKeyProviderName?: string;
  /** Present when credentialMode is "credential". */
  credentialNamespace?: string;
  credentialsGuide: ClientCatalogCredentialsGuide;
}

interface ClientCatalog {
  version: number;
  providers: ClientCatalogEntry[];
}

function loadClientCatalog(): ClientCatalog {
  const catalogPath = join(getRepoRoot(), "meta", "tts-provider-catalog.json");
  const raw = readFileSync(catalogPath, "utf-8");
  return JSON.parse(raw);
}

/**
 * Derive the expected credentialMode and associated metadata from a daemon
 * catalog entry's secret requirements.
 *
 * Convention:
 * - If the first secretRequirement.credentialStoreKey starts with "credential/",
 *   the client uses credentialMode "credential" and credentialNamespace is the
 *   second path segment.
 * - Otherwise, the client uses credentialMode "api-key" and apiKeyProviderName
 *   is the bare key.
 */
function deriveCredentialMetadata(daemonEntry: {
  secretRequirements: readonly { readonly credentialStoreKey: string }[];
}): {
  credentialMode: "api-key" | "credential";
  apiKeyProviderName?: string;
  credentialNamespace?: string;
} {
  const key = daemonEntry.secretRequirements[0]?.credentialStoreKey ?? "";
  if (key.startsWith("credential/")) {
    const parts = key.split("/");
    return { credentialMode: "credential", credentialNamespace: parts[1] };
  }
  return { credentialMode: "api-key", apiKeyProviderName: key };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TTS catalog parity: daemon vs client", () => {
  // -----------------------------------------------------------------------
  // Provider ID parity
  // -----------------------------------------------------------------------

  test("client catalog provider IDs match daemon catalog provider IDs", () => {
    const daemonIds = listCatalogProviderIds();
    const clientCatalog = loadClientCatalog();
    const clientIds = clientCatalog.providers.map((p) => p.id);

    // Every daemon provider ID must appear in the client catalog
    const missingInClient = daemonIds.filter((id) => !clientIds.includes(id));
    if (missingInClient.length > 0) {
      const message = [
        "Daemon catalog has provider IDs not present in meta/tts-provider-catalog.json.",
        "",
        "Missing in client catalog:",
        ...missingInClient.map((id) => `  - ${id}`),
        "",
        "Add entries for these providers to meta/tts-provider-catalog.json.",
      ].join("\n");
      expect(missingInClient, message).toEqual([]);
    }

    // Every client catalog provider ID must appear in the daemon catalog
    const missingInDaemon = clientIds.filter(
      (id) => !daemonIds.includes(id as never),
    );
    if (missingInDaemon.length > 0) {
      const message = [
        "Client catalog (meta/tts-provider-catalog.json) has provider IDs not present in daemon catalog.",
        "",
        "Missing in daemon catalog:",
        ...missingInDaemon.map((id) => `  - ${id}`),
        "",
        "Add entries for these providers to assistant/src/tts/provider-catalog.ts.",
      ].join("\n");
      expect(missingInDaemon, message).toEqual([]);
    }
  });

  test("daemon and client catalog list providers in the same order", () => {
    const daemonIds = listCatalogProviderIds();
    const clientCatalog = loadClientCatalog();
    const clientIds = clientCatalog.providers.map((p) => p.id);

    expect(clientIds).toEqual([...daemonIds]);
  });

  // -----------------------------------------------------------------------
  // Credential metadata parity
  // -----------------------------------------------------------------------

  test("each client catalog entry credentialMode matches its daemon counterpart", () => {
    const clientCatalog = loadClientCatalog();
    const violations: string[] = [];

    for (const clientEntry of clientCatalog.providers) {
      const daemonEntry = getCatalogProvider(clientEntry.id as TtsProviderId);
      if (!daemonEntry) {
        // Covered by the provider ID parity test above
        continue;
      }
      const expected = deriveCredentialMetadata(daemonEntry);
      if (clientEntry.credentialMode !== expected.credentialMode) {
        violations.push(
          `Provider "${clientEntry.id}": client credentialMode="${clientEntry.credentialMode}" ` +
            `!= expected "${expected.credentialMode}" (derived from daemon credentialStoreKey)`,
        );
      }
    }

    if (violations.length > 0) {
      const message = [
        "Credential mode mismatch between daemon and client TTS catalogs.",
        "",
        "Violations:",
        ...violations.map((v) => `  - ${v}`),
        "",
        "Update meta/tts-provider-catalog.json or assistant/src/tts/provider-catalog.ts to match.",
      ].join("\n");
      expect(violations, message).toEqual([]);
    }
  });

  test("api-key providers: client apiKeyProviderName matches daemon credentialStoreKey", () => {
    const clientCatalog = loadClientCatalog();
    const violations: string[] = [];

    for (const clientEntry of clientCatalog.providers) {
      if (clientEntry.credentialMode !== "api-key") continue;

      const daemonEntry = getCatalogProvider(clientEntry.id as TtsProviderId);
      if (!daemonEntry) continue;

      const expected = deriveCredentialMetadata(daemonEntry);
      if (clientEntry.apiKeyProviderName !== expected.apiKeyProviderName) {
        violations.push(
          `Provider "${clientEntry.id}": client apiKeyProviderName="${clientEntry.apiKeyProviderName}" ` +
            `!= expected "${expected.apiKeyProviderName}" (derived from daemon credentialStoreKey)`,
        );
      }
    }

    if (violations.length > 0) {
      const message = [
        "apiKeyProviderName mismatch between daemon and client TTS catalogs.",
        "",
        "Violations:",
        ...violations.map((v) => `  - ${v}`),
        "",
        "Update meta/tts-provider-catalog.json or assistant/src/tts/provider-catalog.ts to match.",
      ].join("\n");
      expect(violations, message).toEqual([]);
    }
  });

  test("credential providers: client credentialNamespace matches daemon credentialStoreKey namespace", () => {
    const clientCatalog = loadClientCatalog();
    const violations: string[] = [];

    for (const clientEntry of clientCatalog.providers) {
      if (clientEntry.credentialMode !== "credential") continue;

      const daemonEntry = getCatalogProvider(clientEntry.id as TtsProviderId);
      if (!daemonEntry) continue;

      const expected = deriveCredentialMetadata(daemonEntry);
      if (clientEntry.credentialNamespace !== expected.credentialNamespace) {
        violations.push(
          `Provider "${clientEntry.id}": client credentialNamespace="${clientEntry.credentialNamespace}" ` +
            `!= expected "${expected.credentialNamespace}" (derived from daemon credentialStoreKey)`,
        );
      }
    }

    if (violations.length > 0) {
      const message = [
        "credentialNamespace mismatch between daemon and client TTS catalogs.",
        "",
        "Violations:",
        ...violations.map((v) => `  - ${v}`),
        "",
        "Update meta/tts-provider-catalog.json or assistant/src/tts/provider-catalog.ts to match.",
      ].join("\n");
      expect(violations, message).toEqual([]);
    }
  });

  // -----------------------------------------------------------------------
  // Display name parity
  // -----------------------------------------------------------------------

  test("each client catalog entry displayName matches its daemon counterpart", () => {
    const clientCatalog = loadClientCatalog();
    const violations: string[] = [];

    for (const clientEntry of clientCatalog.providers) {
      const daemonEntry = getCatalogProvider(clientEntry.id as TtsProviderId);
      if (!daemonEntry) continue;

      if (clientEntry.displayName !== daemonEntry.displayName) {
        violations.push(
          `Provider "${clientEntry.id}": client displayName="${clientEntry.displayName}" ` +
            `!= daemon displayName="${daemonEntry.displayName}"`,
        );
      }
    }

    if (violations.length > 0) {
      const message = [
        "Display name mismatch between daemon and client TTS catalogs.",
        "",
        "Violations:",
        ...violations.map((v) => `  - ${v}`),
        "",
        "Update meta/tts-provider-catalog.json or assistant/src/tts/provider-catalog.ts to match.",
      ].join("\n");
      expect(violations, message).toEqual([]);
    }
  });

  // -----------------------------------------------------------------------
  // Structural sanity
  // -----------------------------------------------------------------------

  test("client catalog JSON has a version field", () => {
    const clientCatalog = loadClientCatalog();
    expect(typeof clientCatalog.version).toBe("number");
    expect(clientCatalog.version).toBeGreaterThanOrEqual(1);
  });

  test("client catalog has at least one provider", () => {
    const clientCatalog = loadClientCatalog();
    expect(clientCatalog.providers.length).toBeGreaterThan(0);
  });

  test("every client catalog entry has required fields", () => {
    const clientCatalog = loadClientCatalog();
    const violations: string[] = [];

    for (const entry of clientCatalog.providers) {
      if (!entry.id || typeof entry.id !== "string") {
        violations.push(`Entry missing or invalid 'id'`);
      }
      if (!entry.displayName || typeof entry.displayName !== "string") {
        violations.push(`${entry.id}: missing or invalid 'displayName'`);
      }
      if (!entry.setupMode || typeof entry.setupMode !== "string") {
        violations.push(`${entry.id}: missing or invalid 'setupMode'`);
      }
      if (
        !entry.credentialMode ||
        !["api-key", "credential"].includes(entry.credentialMode)
      ) {
        violations.push(
          `${entry.id}: missing or invalid 'credentialMode' (expected "api-key" or "credential")`,
        );
      }
      if (entry.credentialMode === "api-key" && !entry.apiKeyProviderName) {
        violations.push(
          `${entry.id}: credentialMode is "api-key" but apiKeyProviderName is missing`,
        );
      }
      if (entry.credentialMode === "credential" && !entry.credentialNamespace) {
        violations.push(
          `${entry.id}: credentialMode is "credential" but credentialNamespace is missing`,
        );
      }
      if (!entry.credentialsGuide || !entry.credentialsGuide.url) {
        violations.push(`${entry.id}: missing or invalid 'credentialsGuide'`);
      }
    }

    if (violations.length > 0) {
      const message = [
        "Client catalog entries have missing or invalid required fields.",
        "",
        "Violations:",
        ...violations.map((v) => `  - ${v}`),
      ].join("\n");
      expect(violations, message).toEqual([]);
    }
  });
});
