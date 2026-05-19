import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

const host = process.env.TAURI_DEV_HOST;
const gatewayTarget = process.env.VITE_GATEWAY_URL ?? "http://127.0.0.1:7830";
const gatewayBearerToken = loadGuardianAccessToken();

const gatewayProxy: ProxyOptions = {
  target: gatewayTarget,
  changeOrigin: true,
  ws: true,
  rewrite: (path: string) => path.replace(/^\/__gateway/, ""),
  configure: (proxy) => {
    proxy.on("proxyReq", (proxyReq) => {
      if (gatewayBearerToken) {
        proxyReq.setHeader("authorization", `Bearer ${gatewayBearerToken}`);
      }
    });
    proxy.on("proxyReqWs", (proxyReq) => {
      if (gatewayBearerToken) {
        proxyReq.setHeader("authorization", `Bearer ${gatewayBearerToken}`);
      }
    });
  },
};

export default defineConfig(() => ({
  plugins: react(),
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws" as const,
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
    proxy: {
      "/__gateway": gatewayProxy,
    },
  },
  build: {
    target: "esnext",
    minify: "esbuild" as const,
    sourcemap: true,
  },
}));

function loadGuardianAccessToken(): string | null {
  const assistantId = loadActiveAssistantId();
  if (!assistantId) return null;

  const tokenPath = join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "vellum",
    "assistants",
    assistantId,
    "guardian-token.json",
  );

  const token = readJsonFile(tokenPath);
  return typeof token?.accessToken === "string" ? token.accessToken : null;
}

function loadActiveAssistantId(): string | null {
  const lockfile = readJsonFile(join(homedir(), ".vellum.lock.json"));
  if (typeof lockfile?.activeAssistant === "string") {
    return lockfile.activeAssistant;
  }

  const assistants = Array.isArray(lockfile?.assistants)
    ? lockfile.assistants
    : [];
  const firstAssistant = assistants.find(
    (entry): entry is { assistantId: string } =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { assistantId?: unknown }).assistantId === "string",
  );
  return firstAssistant?.assistantId ?? null;
}

function readJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
