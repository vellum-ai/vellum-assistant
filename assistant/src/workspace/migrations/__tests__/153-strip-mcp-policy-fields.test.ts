import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { stripMcpPolicyFieldsMigration } from "../153-strip-mcp-policy-fields.js";

function workspaceWith(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "strip-mcp-policy-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2));
  return dir;
}

function readConfig(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("153-strip-mcp-policy-fields", () => {
  test("strips policy fields from each server and from mcp", () => {
    const dir = workspaceWith({
      mcp: {
        globalMaxTools: 80,
        servers: {
          remote: {
            transport: {
              type: "streamable-http",
              url: "https://example.com/mcp",
            },
            enabled: false,
            defaultRiskLevel: "high",
            maxTools: 5,
            allowedTools: ["keep"],
            blockedTools: ["drop"],
          },
        },
      },
    });

    stripMcpPolicyFieldsMigration.run(dir);

    expect(readConfig(dir).mcp).toEqual({
      servers: {
        remote: {
          transport: {
            type: "streamable-http",
            url: "https://example.com/mcp",
          },
        },
      },
    });
  });

  test("leaves transport and unrelated config alone", () => {
    const dir = workspaceWith({
      llm: { activeProfile: "balanced" },
      mcp: {
        servers: {
          local: {
            transport: { type: "stdio", command: "npx", args: ["-y", "srv"] },
            enabled: true,
          },
        },
      },
    });

    stripMcpPolicyFieldsMigration.run(dir);

    const config = readConfig(dir);
    expect(config.llm).toEqual({ activeProfile: "balanced" });
    expect(config.mcp).toEqual({
      servers: {
        local: {
          transport: { type: "stdio", command: "npx", args: ["-y", "srv"] },
        },
      },
    });
  });

  test("is a no-op when policy fields are already gone", () => {
    const original = {
      mcp: {
        servers: {
          remote: {
            transport: {
              type: "streamable-http",
              url: "https://example.com/mcp",
            },
          },
        },
      },
    };
    const dir = workspaceWith(original);
    const before = readFileSync(join(dir, "config.json"), "utf8");

    stripMcpPolicyFieldsMigration.run(dir);

    expect(readFileSync(join(dir, "config.json"), "utf8")).toBe(before);
  });

  test("no-ops when config.json is missing or mcp is absent", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "strip-mcp-policy-empty-"));
    stripMcpPolicyFieldsMigration.run(emptyDir);

    const dir = workspaceWith({ llm: {} });
    stripMcpPolicyFieldsMigration.run(dir);
    expect(readConfig(dir)).toEqual({ llm: {} });
  });

  test("strips policy fields from a legacy array of servers", () => {
    const dir = workspaceWith({
      mcp: {
        globalMaxTools: 50,
        servers: [
          {
            name: "legacy",
            transport: { type: "sse", url: "https://example.com/sse" },
            enabled: true,
            defaultRiskLevel: "low",
          },
        ],
      },
    });

    stripMcpPolicyFieldsMigration.run(dir);

    expect(readConfig(dir).mcp).toEqual({
      servers: [
        {
          name: "legacy",
          transport: { type: "sse", url: "https://example.com/sse" },
        },
      ],
    });
  });
});
