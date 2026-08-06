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
  const AGENT_ID = "ingress-test";

  function writeAgentEntry(extra: Record<string, unknown> = {}): void {
    writeLockfile({
      assistantId: AGENT_ID,
      runtimeUrl: "http://192.168.1.50:7830",
      cloud: "local",
      ...extra,
    });
  }

  test("the record lives on the lockfile entry, never in the workspace or beside it", () => {
    writeAgentEntry();
    const ws = makeWorkspace();

    saveNgrokAgent(AGENT_ID, { webAddrPort: 41234, pid: 55555 });

    expect(readLockfileEntry().ngrokAgent).toEqual({
      webAddrPort: 41234,
      pid: 55555,
    });
    // The workspace config, which travels with moves/restores, is untouched,
    // and no state file appears in the directory containing the workspace
    // (the forbidden `.vellum` tree in the real layout).
    expect(existsSync(join(ws, "config.json"))).toBe(false);
    expect(existsSync(join(dirname(ws), "ngrok-agent.json"))).toBe(false);
  });

  test("save and load round-trip; null clears the field", () => {
    writeAgentEntry();

    saveNgrokAgent(AGENT_ID, { webAddrPort: 41234, pid: 55555 });
    expect(loadNgrokAgent(AGENT_ID)).toEqual({
      webAddrPort: 41234,
      pid: 55555,
    });

    saveNgrokAgent(AGENT_ID, null);
    expect(loadNgrokAgent(AGENT_ID)).toBeNull();
    expect(readLockfileEntry().ngrokAgent).toBeUndefined();
  });

  test("a record without a pid loads with pid null", () => {
    writeAgentEntry();

    saveNgrokAgent(AGENT_ID, { webAddrPort: 41234 });
    expect(loadNgrokAgent(AGENT_ID)).toEqual({ webAddrPort: 41234, pid: null });
    expect(readLockfileEntry().ngrokAgent).toEqual({ webAddrPort: 41234 });
  });

  test("re-saving without a pid drops a previously recorded pid", () => {
    writeAgentEntry();
    saveNgrokAgent(AGENT_ID, { webAddrPort: 41234, pid: 55555 });

    saveNgrokAgent(AGENT_ID, { webAddrPort: 42345, pid: null });
    expect(loadNgrokAgent(AGENT_ID)).toEqual({ webAddrPort: 42345, pid: null });
  });

  test("loadNgrokAgent returns null when nothing is saved", () => {
    writeAgentEntry();
    expect(loadNgrokAgent(AGENT_ID)).toBeNull();
  });

  test("loadNgrokAgent returns null for a malformed record on the entry", () => {
    writeAgentEntry({ ngrokAgent: "not a record" });
    expect(loadNgrokAgent(AGENT_ID)).toBeNull();

    writeAgentEntry({ ngrokAgent: { webAddrPort: "41234" } });
    expect(loadNgrokAgent(AGENT_ID)).toBeNull();
  });

  test("saving a record for an unknown assistant throws; clearing is a no-op", () => {
    writeAgentEntry();

    expect(() => {
      saveNgrokAgent("no-such-assistant", { webAddrPort: 41234 });
    }).toThrow("no assistant entry found");
    expect(() => {
      saveNgrokAgent("no-such-assistant", null);
    }).not.toThrow();
    expect(readLockfileEntry().ngrokAgent).toBeUndefined();
    expect(loadNgrokAgent("no-such-assistant")).toBeNull();
  });

  test("the record and the saved workspace domain are independent", () => {
    writeAgentEntry();
    const ws = makeWorkspace();

    saveNgrokDomain(ws, "foo.ngrok.app");
    saveNgrokAgent(AGENT_ID, { webAddrPort: 41234, pid: 55555 });

    expect(loadNgrokDomain(ws)).toBe("foo.ngrok.app");
    expect(loadNgrokAgent(AGENT_ID)).toEqual({
      webAddrPort: 41234,
      pid: 55555,
    });
    // The domain is the only ngrok state in the workspace config; the agent
    // record never lands there.
    const config = JSON.parse(
      readFileSync(join(ws, "config.json"), "utf-8"),
    ) as { ingress?: { ngrok?: Record<string, unknown> } };
    expect(config.ingress?.ngrok).toEqual({ domain: "foo.ngrok.app" });

    saveNgrokAgent(AGENT_ID, null);
    expect(loadNgrokDomain(ws)).toBe("foo.ngrok.app");

    saveNgrokDomain(ws, null);
    expect(loadNgrokDomain(ws)).toBeNull();
  });
});
