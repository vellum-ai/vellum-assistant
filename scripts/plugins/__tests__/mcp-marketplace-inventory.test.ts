import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { buildBundledPluginPackages } from "../../../assistant/scripts/bundled-plugin-packages.js";
import { readValidatedPluginIcon } from "../../../assistant/src/cli/lib/plugin-icon-file.js";
import { marketplaceManifestSchema } from "../../../assistant/src/cli/lib/plugin-marketplace.js";
import { isIntegrationCategory } from "../../../packages/service-contracts/src/integration-categories.js";

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
      Object.fromEntries(
        integrations
          .filter((entry) => entry.integration?.oauthProvider !== undefined)
          .map((entry) => [entry.name, entry.integration?.oauthProvider]),
      ),
    ).toEqual({
      calendly: "calendly",
      linear: "linear",
      notion: "notion",
      todoist: "todoist",
    });

    for (const entry of integrations) {
      const pluginRoot = join(REPO_ROOT, entry.source.path);
      const plugin = JSON.parse(
        readFileSync(join(pluginRoot, "plugin.json"), "utf8"),
      ) as { version: string };
      expect(entry.source).toEqual({
        source: "local",
        path: `plugins/mcp-catalog/${entry.name}`,
        version: plugin.version,
      });
      expect(entry.integration).toBeDefined();
      // The wire schema takes any string so a newer catalog cannot reject
      // itself; the bundled catalog is held to the shared vocabulary here.
      expect(
        isIntegrationCategory(entry.integration!.category),
        `${entry.name} category ${String(entry.integration!.category)}`,
      ).toBe(true);
      expect(readValidatedPluginIcon(pluginRoot).hasIcon).toBe(true);
      const icon = readFileSync(join(pluginRoot, "icon.png"));
      // Integration rows display 32 CSS pixels, including on 2x screens.
      expect(
        icon.readUInt32BE(16),
        `${entry.name} icon width`,
      ).toBeGreaterThanOrEqual(64);
      expect(
        icon.readUInt32BE(20),
        `${entry.name} icon height`,
      ).toBeGreaterThanOrEqual(64);
      expect(
        readFileSync(
          join(
            REPO_ROOT,
            "clients",
            "web",
            "public",
            "images",
            "integrations",
            entry.integration!.logo,
          ),
        ).equals(readFileSync(join(pluginRoot, "icon.png"))),
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
