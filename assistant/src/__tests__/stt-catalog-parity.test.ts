import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import type { SttProviderId } from "../stt/types.js";
import {
  getProviderEntry,
  listCredentialProviderNames,
  listProviderIds,
} from "../providers/speech-to-text/provider-catalog.js";

/**
 * Parity guard: daemon STT provider catalog vs client STT catalog JSON.
 *
 * The daemon maintains its canonical provider catalog in
 * `assistant/src/providers/speech-to-text/provider-catalog.ts`.
 * The client-facing metadata lives in `meta/stt-provider-catalog.json` and is
 * bundled into native clients at build time.
 *
 * These tests enforce that both catalogs stay in sync on the fields they
 * share: provider IDs and credential-provider (apiKeyProviderName) mappings.
 * CI will fail when they drift, forcing the developer to update whichever
 * side fell behind.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve repo root (tests run from assistant/) */
function getRepoRoot(): string {
  return join(process.cwd(), "..");
}

interface ClientCatalogEntry {
  id: string;
  displayName: string;
  subtitle: string;
  setupMode: string;
  setupHint: string;
  apiKeyProviderName: string;
}

interface ClientCatalog {
  version: number;
  providers: ClientCatalogEntry[];
}

function loadClientCatalog(): ClientCatalog {
  const catalogPath = join(getRepoRoot(), "meta", "stt-provider-catalog.json");
  const raw = readFileSync(catalogPath, "utf-8");
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("STT catalog parity: daemon vs client", () => {
  // -----------------------------------------------------------------------
  // Provider ID parity
  // -----------------------------------------------------------------------

  test("client catalog provider IDs match daemon catalog provider IDs", () => {
    const daemonIds = listProviderIds();
    const clientCatalog = loadClientCatalog();
    const clientIds = clientCatalog.providers.map((p) => p.id);

    // Every daemon provider ID must appear in the client catalog
    const missingInClient = daemonIds.filter((id) => !clientIds.includes(id));
    if (missingInClient.length > 0) {
      const message = [
        "Daemon catalog has provider IDs not present in meta/stt-provider-catalog.json.",
        "",
        "Missing in client catalog:",
        ...missingInClient.map((id) => `  - ${id}`),
        "",
        "Add entries for these providers to meta/stt-provider-catalog.json.",
      ].join("\n");
      expect(missingInClient, message).toEqual([]);
    }

    // Every client catalog provider ID must appear in the daemon catalog
    const missingInDaemon = clientIds.filter(
      (id) => !daemonIds.includes(id as never),
    );
    if (missingInDaemon.length > 0) {
      const message = [
        "Client catalog (meta/stt-provider-catalog.json) has provider IDs not present in daemon catalog.",
        "",
        "Missing in daemon catalog:",
        ...missingInDaemon.map((id) => `  - ${id}`),
        "",
        "Add entries for these providers to assistant/src/providers/speech-to-text/provider-catalog.ts.",
      ].join("\n");
      expect(missingInDaemon, message).toEqual([]);
    }
  });

  test("daemon and client catalog list providers in the same order", () => {
    const daemonIds = listProviderIds();
    const clientCatalog = loadClientCatalog();
    const clientIds = clientCatalog.providers.map((p) => p.id);

    expect(clientIds).toEqual([...daemonIds]);
  });

  // -----------------------------------------------------------------------
  // Credential provider name parity
  // -----------------------------------------------------------------------

  test("client catalog apiKeyProviderName values match daemon credential provider mappings", () => {
    const daemonCredentialNames = listCredentialProviderNames();
    const clientCatalog = loadClientCatalog();
    const clientCredentialNames = clientCatalog.providers.map(
      (p) => p.apiKeyProviderName,
    );

    // Deduplicate client names the same way the daemon does (first-seen order)
    const seen = new Set<string>();
    const deduplicatedClientNames: string[] = [];
    for (const name of clientCredentialNames) {
      if (!seen.has(name)) {
        seen.add(name);
        deduplicatedClientNames.push(name);
      }
    }

    expect(deduplicatedClientNames).toEqual([...daemonCredentialNames]);
  });

  test("each client catalog entry apiKeyProviderName matches its daemon counterpart", () => {
    const clientCatalog = loadClientCatalog();
    const violations: string[] = [];

    for (const clientEntry of clientCatalog.providers) {
      const daemonEntry = getProviderEntry(clientEntry.id as SttProviderId);
      if (!daemonEntry) {
        // Covered by the provider ID parity test above
        continue;
      }
      if (clientEntry.apiKeyProviderName !== daemonEntry.credentialProvider) {
        violations.push(
          `Provider "${clientEntry.id}": client apiKeyProviderName="${clientEntry.apiKeyProviderName}" ` +
            `!= daemon credentialProvider="${daemonEntry.credentialProvider}"`,
        );
      }
    }

    if (violations.length > 0) {
      const message = [
        "Credential provider name mismatch between daemon and client catalogs.",
        "",
        "Violations:",
        ...violations.map((v) => `  - ${v}`),
        "",
        "Update meta/stt-provider-catalog.json or assistant/src/providers/speech-to-text/provider-catalog.ts to match.",
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
      if (
        !entry.apiKeyProviderName ||
        typeof entry.apiKeyProviderName !== "string"
      ) {
        violations.push(`${entry.id}: missing or invalid 'apiKeyProviderName'`);
      }
      if (!entry.setupMode || typeof entry.setupMode !== "string") {
        violations.push(`${entry.id}: missing or invalid 'setupMode'`);
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
