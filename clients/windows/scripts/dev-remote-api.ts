#!/usr/bin/env bun
/** Run the local renderer against the platform URL supplied by VELLUM_DEV_URL. */
import { spawn, type ChildProcess } from "node:child_process";

const remoteUrl = process.env.VELLUM_DEV_URL;
if (!remoteUrl) {
  throw new Error(
    "VELLUM_DEV_URL is required, for example https://dev-assistant.vellum.ai/assistant",
  );
}

let remoteOrigin: string;
try {
  const parsed = new URL(remoteUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("unsupported protocol");
  }
  remoteOrigin = parsed.origin;
} catch {
  throw new Error("VELLUM_DEV_URL must be an http(s) URL");
}

const localRendererUrl = "http://localhost:5173/assistant";
const web = spawn("bun", ["run", "dev:web"], {
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_PLATFORM_MODE: "true",
    API_PROXY_TARGET: remoteOrigin,
    GATEWAY_PROXY_TARGET: remoteOrigin,
  },
});
const electron = spawn("bun", ["run", "dev:electron"], {
  stdio: "inherit",
  env: {
    ...process.env,
    VELLUM_DEV_URL: localRendererUrl,
    VELLUM_PLATFORM_URL: remoteOrigin,
    VELLUM_WEB_URL: remoteOrigin,
  },
});
const children: ChildProcess[] = [web, electron];

let stopping = false;
const stop = (code: number): void => {
  if (stopping) {
    return;
  }
  stopping = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }
  process.exitCode = code;
};

for (const child of children) {
  child.once("exit", (code) => stop(code ?? 1));
}
process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));
