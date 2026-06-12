import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  test("proxies selected gateway-owned routes to the gateway", () => {
    expect(conf).toContain("location = /webhooks/telegram");
    expect(conf).toContain("location = /v1/contacts");
    expect(conf).toContain("location = /v1/feature-flags");
    expect(conf).toContain("location ~ ^/v1/oauth/apps/[^/]+/connect/?$");
    expect(conf).toContain(
      "location ~ ^/v1/assistants/[^/]+/trust-rules/[^/]+/?$",
    );
    expect(conf).toContain("proxy_pass http://127.0.0.1:7830;");
  });

  test("does not pass unknown paths to the gateway runtime proxy", () => {
    expect(conf).toContain(`    location / {
      return 404;
    }`);
    expect(conf).not.toContain(`    location / {
      proxy_pass`);
  });

  test("does not set a Vellum-specific forwarded marker", () => {
    expect(conf).not.toContain("X-Vellum-Edge-Forwarded");
  });

  test("blocks local-only gateway endpoints at nginx", () => {
    expect(conf).toContain("location = /auth/token");
    expect(conf).toContain("location = /v1/pair");
    expect(conf).toContain("location = /v1/devices");
    expect(conf).toContain("location = /v1/devices/revoke");
    expect(conf).toContain("location = /v1/guardian/init");
    expect(conf).toContain("location = /v1/guardian/reset-bootstrap");
    expect(conf.match(/return 403;/g)?.length).toBe(6);
  });

  test("overwrites forwarded headers instead of appending client values", () => {
    expect(conf).toContain("proxy_set_header X-Forwarded-For $remote_addr;");
    expect(conf).toContain("proxy_set_header X-Forwarded-Host $host;");
    expect(conf).toContain("proxy_set_header X-Forwarded-Proto $scheme;");
    expect(conf).not.toContain("$proxy_add_x_forwarded_for");
    expect(conf).not.toContain("$http_x_forwarded_for");
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
