import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { marketplaceManifestSchema } from "../../../assistant/src/cli/lib/plugin-marketplace.js";
import { buildBundledPluginPackages } from "../../../assistant/scripts/bundled-plugin-packages.js";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

const EXPECTED_PROVIDERS = [
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
] as const;

describe("bundled MCP marketplace inventory", () => {
  test("ships the reviewed 37-provider inventory and every declared logo", () => {
    const raw = JSON.parse(
      readFileSync(join(REPO_ROOT, "plugins", "marketplace.json"), "utf8"),
    ) as unknown;
    const manifest = marketplaceManifestSchema.parse(raw);
    const integrations = manifest.plugins.filter(
      (entry) => entry.source.source === "local",
    );

    expect(integrations.map((entry) => entry.name).sort()).toEqual(
      [...EXPECTED_PROVIDERS].sort(),
    );
    expect(
      integrations.filter((entry) => entry.integration?.setup.mode === "oauth"),
    ).toHaveLength(36);
    expect(
      integrations.filter(
        (entry) => entry.integration?.setup.mode === "manual",
      ),
    ).toEqual([expect.objectContaining({ name: "ramp" })]);
    expect(
      integrations
        .filter((entry) => entry.integration?.oauthProvider !== undefined)
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(["linear", "notion"]);

    for (const entry of integrations) {
      expect(entry.source).toEqual({
        source: "local",
        path: `plugins/mcp-catalog/${entry.name}`,
        version: "1.0.0",
      });
      expect(entry.integration).toBeDefined();
      expect(
        existsSync(
          join(
            REPO_ROOT,
            "clients",
            "web",
            "public",
            "images",
            "integrations",
            entry.integration!.logo,
          ),
        ),
      ).toBe(true);

      const mcp = JSON.parse(
        readFileSync(join(REPO_ROOT, entry.source.path, "mcp.json"), "utf8"),
      ) as { mcpServers: Record<string, unknown> };
      expect(Object.keys(mcp.mcpServers)).toEqual([entry.name]);
    }

    expect(Object.keys(buildBundledPluginPackages(REPO_ROOT)).sort()).toEqual(
      integrations.map((entry) => entry.source.path).sort(),
    );
  });
});
