import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  buildIngressNginxConfig,
  resolveTunnelTargetPort,
} from "../lib/nginx-ingress.js";

describe("buildIngressNginxConfig", () => {
  const conf = buildIngressNginxConfig({ gatewayPort: 7830, listenPort: 7840 });

  test("listens on loopback only", () => {
    expect(conf).toContain("listen 127.0.0.1:7840;");
    const listens = conf.match(/listen [^;]+;/g) ?? [];
    expect(listens.length).toBeGreaterThan(0);
    for (const directive of listens) {
      expect(directive).toContain("127.0.0.1");
    }
  });

  test("proxies all routes to the gateway", () => {
    expect(conf).toContain("proxy_pass http://127.0.0.1:7830;");
  });

  test("stamps the unspoofable edge marker", () => {
    // proxy_set_header REPLACES any client-supplied value — remote callers can
    // neither forge nor strip the marker.
    expect(conf).toContain('proxy_set_header X-Vellum-Edge-Forwarded "1";');
  });

  test("edge marker name matches the gateway's EDGE_FORWARDED_HEADER constant", () => {
    const gatewaySource = readFileSync(
      join(
        import.meta.dir,
        "../../../gateway/src/http/edge-forwarded-header.ts",
      ),
      "utf-8",
    );
    expect(gatewaySource).toContain('"x-vellum-edge-forwarded"');
  });

  test("never uses the client-influencable XFF append", () => {
    // Appending keeps a client-spoofed leftmost X-Forwarded-For entry, which
    // the gateway's trustProxy logic reads. The marker is the trust boundary;
    // XFF is passthrough-only.
    expect(conf).not.toContain("$proxy_add_x_forwarded_for");
  });

  test("sets response security headers", () => {
    expect(conf).toContain(
      'add_header X-Content-Type-Options "nosniff" always;',
    );
    expect(conf).toContain('add_header X-Frame-Options "DENY" always;');
    expect(conf).toContain('add_header Referrer-Policy "no-referrer" always;');
  });

  test("supports websockets and SSE streaming", () => {
    expect(conf).toContain("map $http_upgrade $connection_upgrade");
    expect(conf).toContain("proxy_set_header Upgrade $http_upgrade;");
    expect(conf).toContain("proxy_set_header Connection $connection_upgrade;");
    expect(conf).toContain("proxy_buffering off;");
    expect(conf).toContain("proxy_read_timeout 1h;");
  });
});

describe("resolveTunnelTargetPort", () => {
  const workspaces: string[] = [];

  afterEach(() => {
    for (const dir of workspaces.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeWorkspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "vellum-ingress-test-"));
    workspaces.push(dir);
    return dir;
  }

  function writeIngressState(workspaceDir: string, listenPort: number): void {
    writeFileSync(
      join(workspaceDir, "config.json"),
      JSON.stringify({ ingress: { nginx: { listenPort } } }) + "\n",
    );
  }

  function writePidFile(workspaceDir: string, pid: number): void {
    const dir = join(workspaceDir, "data", "ingress");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "nginx.pid"), `${pid}\n`);
  }

  /** A PID guaranteed dead: a short-lived child that has already exited. */
  function deadPid(): number {
    const result = spawnSync("sh", ["-c", "exit 0"]);
    if (!result.pid) throw new Error("failed to spawn probe process");
    return result.pid;
  }

  test("falls back to the gateway port when no ingress state exists", () => {
    const ws = makeWorkspace();
    expect(resolveTunnelTargetPort(ws, 7830)).toEqual({
      port: 7830,
      viaIngress: false,
    });
  });

  test("falls back when ingress state exists but the process is dead", () => {
    const ws = makeWorkspace();
    writeIngressState(ws, 7841);
    writePidFile(ws, deadPid());
    expect(resolveTunnelTargetPort(ws, 7830)).toEqual({
      port: 7830,
      viaIngress: false,
    });
  });

  test("targets the ingress when state exists and the process is alive", () => {
    const ws = makeWorkspace();
    writeIngressState(ws, 7841);
    writePidFile(ws, process.pid);
    expect(resolveTunnelTargetPort(ws, 7830)).toEqual({
      port: 7841,
      viaIngress: true,
    });
  });
});
