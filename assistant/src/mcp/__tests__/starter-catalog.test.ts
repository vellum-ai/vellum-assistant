import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

import bundledCatalog from "../bundled-catalog.json" with { type: "json" };
import { generateMcpCatalog } from "../catalog-generator.js";
import {
  parseStandardDefinitions,
  standardDefinitionDigest,
} from "../standard-definitions.js";

describe("reviewed starter MCP catalog", () => {
  test("bundles all requested providers with usable standard definitions and honest verification", () => {
    expect(bundledCatalog.entries.map((entry) => entry.id)).toEqual([
      "amplemarket",
      "ashby",
      "atlassian",
      "attio",
      "brex",
      "calendly",
      "circleback",
      "clay",
      "craft",
      "customer-io",
      "fathom",
      "fireflies",
      "gamma",
      "guru",
      "interactive-brokers",
      "intercom",
      "jotform",
      "juicebox",
      "klaviyo",
      "linear",
      "mailerlite",
      "meltwater",
      "mem",
      "mercury",
      "navan",
      "notion",
      "otter",
      "profound",
      "ramp",
      "readwise",
      "semrush",
      "sentry",
      "stripe",
      "todoist",
      "typeform",
      "upwork",
      "webull",
    ]);
    for (const entry of bundledCatalog.entries) {
      const result = parseStandardDefinitions(
        entry.documents.plugin,
        entry.documents.mcp,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("Invalid bundled definition");
      }
      expect(result.issues).toEqual([]);
      expect(Object.hasOwn(result.servers, entry.serverKey)).toBe(true);
      expect(result.servers[entry.serverKey]?.headers).toBeUndefined();
      expect(standardDefinitionDigest(result.documents)).toBe(
        entry.definitionDigest,
      );
      expect(entry.verification).toBe("documentation-only");
      expect(entry.setup.instructions.length).toBeGreaterThan(0);
      if ("icon" in entry) {
        expect(entry.icon).toBe(entry.id);
      }
    }
  });

  test("keeps Ramp setup-required and limits OAuth brand grouping to explicit equivalents", () => {
    expect(
      bundledCatalog.entries.find((entry) => entry.id === "ramp")?.setup.mode,
    ).toBe("manual");
    expect(
      bundledCatalog.entries.flatMap((entry) =>
        "oauthProvider" in entry && entry.oauthProvider
          ? [entry.oauthProvider]
          : [],
      ),
    ).toEqual(["calendly", "linear", "notion", "todoist"]);
    expect(
      bundledCatalog.entries.find((entry) => entry.id === "asana"),
    ).toBeUndefined();
  });

  test("records Atlassian's immutable provider source", () => {
    const entry = bundledCatalog.entries.find(
      (candidate) => candidate.id === "atlassian",
    )!;
    expect(entry.source.kind).toBe("github");
    if (
      entry.source.kind === "github" &&
      "repository" in entry.source &&
      entry.source.repository
    ) {
      expect(entry.source.repository.repo).toBe(
        "atlassian/atlassian-mcp-server",
      );
      expect(entry.source.repository.ref).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  test("matches reviewed source documents and their regeneration", async () => {
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    await generateMcpCatalog(root, true);
    for (const entry of bundledCatalog.entries) {
      const raw = JSON.parse(
        await readFile(join(root, entry.packagePath, "mcp.json"), "utf8"),
      );
      expect(entry.documents.mcp).toEqual(raw);
    }
  });
});
