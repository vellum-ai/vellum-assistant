/**
 * Unit tests for the credential metadata merge helper used by the bundle
 * importers. Covers the behaviour the two importers rely on:
 *
 * - Bundle without vellum + target with vellum → target's vellum entries
 *   survive and the bundle's non-vellum entries are kept.
 * - Bundle with mixed user services → non-vellum entries import, any
 *   rogue vellum entries in the bundle are dropped.
 * - Live metadata empty / missing → bundle lands as-is.
 * - Malformed inputs → no corruption (bundle returned verbatim).
 */

import { describe, expect, test } from "bun:test";

import { mergeMetadataPreservingVellum } from "../vbundle-metadata-merge.js";

interface Record {
  credentialId: string;
  service: string;
  field: string;
  allowedTools: string[];
  allowedDomains: string[];
  createdAt: number;
  updatedAt: number;
}

function record(
  overrides: Partial<Record> & Pick<Record, "service" | "field">,
): Record {
  const now = Date.now();
  return {
    credentialId: `id-${overrides.service}-${overrides.field}`,
    allowedTools: [],
    allowedDomains: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function file(records: Record[], version = 5): string {
  return JSON.stringify({ version, credentials: records });
}

function parse(json: string): { version?: number; credentials: Record[] } {
  const parsed = JSON.parse(json);
  return {
    version: parsed.version,
    credentials: (parsed.credentials ?? []) as Record[],
  };
}

function asKey(r: Record): string {
  return `${r.service}:${r.field}`;
}

function keys(records: Record[]): Set<string> {
  return new Set(records.map(asKey));
}

const VELLUM_FIELDS = [
  "platform_base_url",
  "assistant_api_key",
  "platform_assistant_id",
  "webhook_secret",
] as const;

function vellumRecords(): Record[] {
  return VELLUM_FIELDS.map((field) =>
    record({ service: "vellum", field, credentialId: `target-${field}` }),
  );
}

describe("mergeMetadataPreservingVellum", () => {
  test("preserves all four target vellum:* entries when bundle has none", () => {
    const target = vellumRecords();
    const bundle = [
      record({ service: "telegram", field: "bot_token" }),
      record({ service: "slack_channel", field: "app_token" }),
    ];

    const merged = parse(
      mergeMetadataPreservingVellum(file(bundle), file(target)),
    );

    const mergedKeys = keys(merged.credentials);
    for (const field of VELLUM_FIELDS) {
      expect(mergedKeys.has(`vellum:${field}`)).toBe(true);
    }
    expect(mergedKeys.has("telegram:bot_token")).toBe(true);
    expect(mergedKeys.has("slack_channel:app_token")).toBe(true);
  });

  test("bundle non-vellum entries still import alongside preserved vellum entries", () => {
    const target = vellumRecords();
    const bundle = [
      record({ service: "telegram", field: "bot_token" }),
      record({ service: "telegram", field: "webhook_secret" }),
      record({ service: "google", field: "access_token" }),
    ];

    const merged = parse(
      mergeMetadataPreservingVellum(file(bundle), file(target)),
    );

    // 4 vellum + 3 user = 7 total.
    expect(merged.credentials.length).toBe(7);
    expect(keys(merged.credentials).size).toBe(7);

    // Target's credentialIds for vellum are preserved (not the bundle's).
    for (const r of merged.credentials) {
      if (r.service === "vellum") {
        expect(r.credentialId.startsWith("target-")).toBe(true);
      }
    }
  });

  test("drops bundle vellum:* entries and preserves target's identity", () => {
    const target = vellumRecords();
    // Bundle carries conflicting vellum entries — should be dropped even
    // though the source would normally be filtered before this helper is
    // called.
    const bundle = [
      record({
        service: "vellum",
        field: "assistant_api_key",
        credentialId: "source-rogue",
      }),
      record({
        service: "vellum",
        field: "platform_base_url",
        credentialId: "source-rogue-url",
      }),
      record({ service: "telegram", field: "bot_token" }),
    ];

    const merged = parse(
      mergeMetadataPreservingVellum(file(bundle), file(target)),
    );

    const vellumRecordsOut = merged.credentials.filter(
      (r) => r.service === "vellum",
    );
    expect(vellumRecordsOut.length).toBe(4);
    for (const r of vellumRecordsOut) {
      expect(r.credentialId.startsWith("target-")).toBe(true);
    }
    // Telegram entry still imports.
    expect(
      merged.credentials.some(
        (r) => r.service === "telegram" && r.field === "bot_token",
      ),
    ).toBe(true);
  });

  test("no live metadata → bundle passes through unchanged (no vellum in bundle)", () => {
    const bundle = [
      record({ service: "telegram", field: "bot_token" }),
      record({ service: "slack_channel", field: "app_token" }),
    ];
    const merged = parse(mergeMetadataPreservingVellum(file(bundle), null));
    expect(keys(merged.credentials)).toEqual(
      new Set(["telegram:bot_token", "slack_channel:app_token"]),
    );
  });

  test("no live metadata still strips bundle vellum:* entries", () => {
    const bundle = [
      record({ service: "vellum", field: "assistant_api_key" }),
      record({ service: "telegram", field: "bot_token" }),
    ];
    const merged = parse(mergeMetadataPreservingVellum(file(bundle), null));
    // Bundle's vellum entry is always filtered.
    expect(merged.credentials.length).toBe(1);
    expect(merged.credentials[0]?.service).toBe("telegram");
  });

  test("preserves bundle version field verbatim", () => {
    const bundle = file([record({ service: "telegram", field: "bot_token" })]);
    const merged = JSON.parse(
      mergeMetadataPreservingVellum(bundle, file(vellumRecords())),
    );
    expect(merged.version).toBe(5);
  });

  test("malformed bundle JSON → returned unchanged (never corrupt the file)", () => {
    const bad = "{not valid json";
    const live = file(vellumRecords());
    const result = mergeMetadataPreservingVellum(bad, live);
    expect(result).toBe(bad);
  });

  test("malformed live JSON → bundle returned as merged output without preservation", () => {
    const bundle = file([record({ service: "telegram", field: "bot_token" })]);
    const merged = parse(mergeMetadataPreservingVellum(bundle, "{bad"));
    expect(keys(merged.credentials)).toEqual(new Set(["telegram:bot_token"]));
  });

  test("live metadata with extra non-vellum entries does NOT smuggle them in", () => {
    const live = file([
      ...vellumRecords(),
      record({ service: "telegram", field: "bot_token" }),
      record({ service: "notion", field: "api_key" }),
    ]);
    const bundle = file([
      record({ service: "slack_channel", field: "app_token" }),
    ]);

    const merged = parse(mergeMetadataPreservingVellum(bundle, live));

    // Only bundle's non-vellum + target's vellum. Target's user entries
    // must NOT carry over (they belong to source-style flows, handled by
    // the bundle).
    expect(keys(merged.credentials).has("slack_channel:app_token")).toBe(true);
    expect(keys(merged.credentials).has("telegram:bot_token")).toBe(false);
    expect(keys(merged.credentials).has("notion:api_key")).toBe(false);
    for (const field of VELLUM_FIELDS) {
      expect(keys(merged.credentials).has(`vellum:${field}`)).toBe(true);
    }
  });
});
