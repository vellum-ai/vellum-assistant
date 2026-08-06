import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Real assistant-config reads the lockfile from VELLUM_LOCKFILE_DIR.
const testDir = mkdtempSync(join(tmpdir(), "ingress-config-test-"));
process.env.VELLUM_LOCKFILE_DIR = testDir;

import {
  clearIngressUrl,
  getNgrokAgentStatePath,
  loadNgrokAgent,
  loadNgrokDomain,
  saveIngressUrl,
  saveNgrokAgent,
  saveNgrokDomain,
} from "../lib/ingress-config.js";

function writeLockfile(entry: Record<string, unknown>): void {
  writeFileSync(
    join(testDir, ".vellum.lock.json"),
    JSON.stringify({ assistants: [entry], activeAssistant: "ingress-test" }),
  );
}

function readLockfileEntry(): Record<string, unknown> {
  const data = JSON.parse(
    readFileSync(join(testDir, ".vellum.lock.json"), "utf-8"),
  ) as { assistants: Record<string, unknown>[] };
  return data.assistants[0];
}

const tempDirs: string[] = [];

function makeWorkspace(): string {
  // Mirror the real layout (`<parent>/workspace`) so host-local agent state
  // lands in an isolated parent dir, not the shared tmpdir.
  const base = mkdtempSync(join(tmpdir(), "ingress-config-ws-"));
  tempDirs.push(base);
  const ws = join(base, "workspace");
  mkdirSync(ws, { recursive: true });
  return ws;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ingress lockfile mirroring", () => {
  test("saveIngressUrl stamps the entry's ingressUrl when given an assistantId", () => {
    writeLockfile({
      assistantId: "ingress-test",
      runtimeUrl: "http://192.168.1.50:7830",
      cloud: "local",
    });
    const ws = makeWorkspace();

    saveIngressUrl(ws, "https://tunnel.example.ts.net", "ingress-test");

    // Both contracts are written: workspace config (gateway-facing)...
    const config = JSON.parse(readFileSync(join(ws, "config.json"), "utf-8"));
    expect(config.ingress.publicBaseUrl).toBe("https://tunnel.example.ts.net");
    // ...and the lockfile entry (CLI-facing).
    expect(readLockfileEntry().ingressUrl).toBe(
      "https://tunnel.example.ts.net",
    );
  });

  test("clearIngressUrl removes the entry's ingressUrl", () => {
    writeLockfile({
      assistantId: "ingress-test",
      runtimeUrl: "http://192.168.1.50:7830",
      cloud: "local",
      ingressUrl: "https://tunnel.example.ts.net",
    });
    const ws = makeWorkspace();
    saveIngressUrl(ws, "https://tunnel.example.ts.net");

    clearIngressUrl(ws, "ingress-test");

    const config = JSON.parse(readFileSync(join(ws, "config.json"), "utf-8"));
    expect(config.ingress.publicBaseUrl).toBeUndefined();
    expect(readLockfileEntry().ingressUrl).toBeUndefined();
  });

  test("without an assistantId the lockfile is untouched", () => {
    writeLockfile({
      assistantId: "ingress-test",
      runtimeUrl: "http://192.168.1.50:7830",
      cloud: "local",
    });
    const ws = makeWorkspace();

    saveIngressUrl(ws, "https://tunnel.example.ts.net");

    expect(readLockfileEntry().ingressUrl).toBeUndefined();
  });

  test("an unknown assistantId is a no-op, not an error", () => {
    writeLockfile({
      assistantId: "ingress-test",
      runtimeUrl: "http://192.168.1.50:7830",
      cloud: "local",
    });
    const ws = makeWorkspace();

    expect(() => {
      saveIngressUrl(ws, "https://tunnel.example.ts.net", "no-such-assistant");
    }).not.toThrow();
    expect(readLockfileEntry().ingressUrl).toBeUndefined();
  });
});

describe("ngrok dedicated-agent persistence", () => {
  function readNgrokEntry(ws: string): Record<string, unknown> | undefined {
    const configPath = join(ws, "config.json");
    if (!existsSync(configPath)) return undefined;
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
      ingress?: { ngrok?: Record<string, unknown> };
    };
    return config.ingress?.ngrok;
  }

  test("the record lives beside the workspace, never inside it", () => {
    const ws = makeWorkspace();

    saveNgrokAgent(ws, { webAddrPort: 41234, pid: 55555 });

    // Host-local state: a sibling of the workspace dir, beside the pid files.
    expect(getNgrokAgentStatePath(ws)).toBe(
      join(dirname(ws), "ngrok-agent.json"),
    );
    expect(existsSync(getNgrokAgentStatePath(ws))).toBe(true);
    // The workspace config, which travels with moves/restores, is untouched.
    expect(existsSync(join(ws, "config.json"))).toBe(false);
  });

  test("save and load round-trip; null clears", () => {
    const ws = makeWorkspace();

    saveNgrokAgent(ws, { webAddrPort: 41234, pid: 55555 });
    expect(loadNgrokAgent(ws)).toEqual({ webAddrPort: 41234, pid: 55555 });

    saveNgrokAgent(ws, null);
    expect(loadNgrokAgent(ws)).toBeNull();
    expect(existsSync(getNgrokAgentStatePath(ws))).toBe(false);
  });

  test("a record without a pid loads with pid null", () => {
    const ws = makeWorkspace();

    saveNgrokAgent(ws, { webAddrPort: 41234 });
    expect(loadNgrokAgent(ws)).toEqual({ webAddrPort: 41234, pid: null });
    expect(
      JSON.parse(readFileSync(getNgrokAgentStatePath(ws), "utf-8")),
    ).toEqual({ webAddrPort: 41234 });
  });

  test("re-saving without a pid drops a previously recorded pid", () => {
    const ws = makeWorkspace();
    saveNgrokAgent(ws, { webAddrPort: 41234, pid: 55555 });

    saveNgrokAgent(ws, { webAddrPort: 42345, pid: null });
    expect(loadNgrokAgent(ws)).toEqual({ webAddrPort: 42345, pid: null });
  });

  test("loadNgrokAgent returns null when nothing is saved", () => {
    expect(loadNgrokAgent(makeWorkspace())).toBeNull();
  });

  test("loadNgrokAgent returns null for a corrupt or malformed record", () => {
    const ws = makeWorkspace();

    writeFileSync(getNgrokAgentStatePath(ws), "not json");
    expect(loadNgrokAgent(ws)).toBeNull();

    writeFileSync(
      getNgrokAgentStatePath(ws),
      JSON.stringify({ webAddrPort: "41234" }),
    );
    expect(loadNgrokAgent(ws)).toBeNull();
  });

  test("loadNgrokAgent ignores legacy agent keys in the workspace config", () => {
    const ws = makeWorkspace();
    writeFileSync(
      join(ws, "config.json"),
      JSON.stringify({
        ingress: { ngrok: { webAddrPort: 41234, agentPid: 55555 } },
      }),
    );

    // A record written by an older CLI is meaningless on another host.
    expect(loadNgrokAgent(ws)).toBeNull();
  });

  test("saveNgrokDomain scrubs legacy agent keys from the workspace config", () => {
    const ws = makeWorkspace();
    writeFileSync(
      join(ws, "config.json"),
      JSON.stringify({
        ingress: {
          ngrok: { domain: "foo.ngrok.app", webAddrPort: 41234, agentPid: 5 },
        },
      }),
    );

    saveNgrokDomain(ws, "bar.ngrok.app");
    expect(readNgrokEntry(ws)).toEqual({ domain: "bar.ngrok.app" });

    saveNgrokDomain(ws, null);
    // Scrubbing the legacy keys and the domain drops the entry entirely.
    expect(readNgrokEntry(ws)).toBeUndefined();
  });

  test("saveNgrokDomain preserves the persisted agent record", () => {
    const ws = makeWorkspace();
    saveNgrokAgent(ws, { webAddrPort: 41234, pid: 55555 });

    saveNgrokDomain(ws, "foo.ngrok.app");
    expect(loadNgrokDomain(ws)).toBe("foo.ngrok.app");
    expect(loadNgrokAgent(ws)).toEqual({ webAddrPort: 41234, pid: 55555 });

    saveNgrokDomain(ws, null);
    expect(loadNgrokDomain(ws)).toBeNull();
    expect(loadNgrokAgent(ws)).toEqual({ webAddrPort: 41234, pid: 55555 });
  });

  test("saveNgrokAgent preserves the saved domain", () => {
    const ws = makeWorkspace();
    saveNgrokDomain(ws, "foo.ngrok.app");

    saveNgrokAgent(ws, { webAddrPort: 41234, pid: 55555 });
    saveNgrokAgent(ws, null);
    expect(loadNgrokDomain(ws)).toBe("foo.ngrok.app");
  });
});
