import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real assistant-config reads the lockfile from VELLUM_LOCKFILE_DIR.
const testDir = mkdtempSync(join(tmpdir(), "ingress-config-test-"));
process.env.VELLUM_LOCKFILE_DIR = testDir;

import {
  clearIngressUrl,
  loadLastTunnel,
  loadRecordedAssistantId,
  saveIngressUrl,
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
  const dir = mkdtempSync(join(tmpdir(), "ingress-config-ws-"));
  tempDirs.push(dir);
  return dir;
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

describe("last-tunnel record", () => {
  function readIngress(ws: string) {
    const config = JSON.parse(readFileSync(join(ws, "config.json"), "utf-8"));
    return config.ingress;
  }

  test("saveIngressUrl records the provider, URL, and assistant ID", () => {
    const ws = makeWorkspace();

    saveIngressUrl(
      ws,
      "https://a.trycloudflare.com",
      "ingress-test",
      "cloudflare",
    );

    const ingress = readIngress(ws);
    expect(ingress.publicBaseUrl).toBe("https://a.trycloudflare.com");
    expect(ingress.lastTunnel).toEqual({
      provider: "cloudflare",
      publicBaseUrl: "https://a.trycloudflare.com",
    });
    expect(ingress.assistantId).toBe("ingress-test");
    expect(loadLastTunnel(ws)).toEqual({
      provider: "cloudflare",
      publicBaseUrl: "https://a.trycloudflare.com",
    });
    expect(loadRecordedAssistantId(ws)).toBe("ingress-test");
  });

  test("clearIngressUrl drops the URL but keeps the tunnel and assistant records", () => {
    const ws = makeWorkspace();
    saveIngressUrl(
      ws,
      "https://tunnel.example.ts.net",
      "ingress-test",
      "tailscale",
    );

    clearIngressUrl(ws);

    expect(readIngress(ws).publicBaseUrl).toBeUndefined();
    expect(loadLastTunnel(ws)).toEqual({
      provider: "tailscale",
      publicBaseUrl: "https://tunnel.example.ts.net",
    });
    expect(loadRecordedAssistantId(ws)).toBe("ingress-test");
  });

  test("saving without a provider leaves an existing lastTunnel untouched", () => {
    const ws = makeWorkspace();
    saveIngressUrl(ws, "https://one.ngrok.app", undefined, "ngrok");

    saveIngressUrl(ws, "https://two.ngrok.app");

    expect(readIngress(ws).publicBaseUrl).toBe("https://two.ngrok.app");
    expect(loadLastTunnel(ws)).toEqual({
      provider: "ngrok",
      publicBaseUrl: "https://one.ngrok.app",
    });
  });

  test("loadLastTunnel returns null for missing, unknown, or empty records", () => {
    const missing = makeWorkspace();
    expect(loadLastTunnel(missing)).toBeNull();
    expect(loadRecordedAssistantId(missing)).toBeNull();

    saveIngressUrl(missing, "https://one.ngrok.app");
    expect(loadLastTunnel(missing)).toBeNull();
    expect(loadRecordedAssistantId(missing)).toBeNull();

    const unknown = makeWorkspace();
    writeFileSync(
      join(unknown, "config.json"),
      JSON.stringify({
        ingress: {
          lastTunnel: {
            provider: "wireguard",
            publicBaseUrl: "https://x.test",
          },
        },
      }),
    );
    expect(loadLastTunnel(unknown)).toBeNull();

    const emptyUrl = makeWorkspace();
    writeFileSync(
      join(emptyUrl, "config.json"),
      JSON.stringify({
        ingress: { lastTunnel: { provider: "ngrok", publicBaseUrl: "  " } },
      }),
    );
    expect(loadLastTunnel(emptyUrl)).toBeNull();
  });
});
