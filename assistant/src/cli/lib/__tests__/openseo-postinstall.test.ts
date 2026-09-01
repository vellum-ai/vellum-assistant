import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

const ADAPTER = join(import.meta.dir, "../../../../../plugins/openseo/postinstall.ts");

function runAdapter(cwd: string): ReturnType<typeof spawnSync> {
  return spawnSync("bun", [ADAPTER], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
}

describe("openseo postinstall adapter", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function stage(mcp: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "openseo-adapter-"));
    dirs.push(dir);
    writeFileSync(join(dir, "mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`);
    return dir;
  }

  test("adds streamable-http when the upstream entry omits type", () => {
    const dir = stage({
      mcpServers: {
        openseo: { url: "https://app.openseo.so/mcp" },
      },
    });

    const result = runAdapter(dir);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");

    const adapted = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
    expect(adapted).toEqual({
      mcpServers: {
        openseo: {
          url: "https://app.openseo.so/mcp",
          type: "streamable-http",
        },
      },
    });
  });

  test("rewrites the Claude-style http alias to streamable-http", () => {
    const dir = stage({
      mcpServers: {
        openseo: { type: "http", url: "https://app.openseo.so/mcp" },
      },
    });

    const result = runAdapter(dir);
    expect(result.status).toBe(0);

    const adapted = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
    expect(adapted.mcpServers.openseo.type).toBe("streamable-http");
    expect(adapted.mcpServers.openseo.url).toBe("https://app.openseo.so/mcp");
  });

  test("leaves an already-valid streamable-http entry in place", () => {
    const dir = stage({
      mcpServers: {
        openseo: {
          type: "streamable-http",
          url: "https://app.openseo.so/mcp",
        },
      },
    });

    const result = runAdapter(dir);
    expect(result.status).toBe(0);

    const adapted = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
    expect(adapted.mcpServers.openseo).toEqual({
      type: "streamable-http",
      url: "https://app.openseo.so/mcp",
    });
  });

  test("fails the install when mcp.json is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "openseo-adapter-"));
    dirs.push(dir);

    const result = runAdapter(dir);
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain("mcp.json");
  });

  test("fails the install when a server has no url", () => {
    const dir = stage({
      mcpServers: {
        openseo: { type: "http" },
      },
    });

    const result = runAdapter(dir);
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain("url");
  });
});
