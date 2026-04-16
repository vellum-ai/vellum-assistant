import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { extname, join } from "node:path";

import { ensureBun } from "../util/bun-runtime.js";
import { getWorkspaceDir } from "../util/platform.js";
import { getHookSettings } from "./config.js";
import type { DiscoveredHook, HookEventData } from "./types.js";

async function getSpawnArgs(
  scriptPath: string,
): Promise<{ command: string; args: string[] }> {
  const ext = extname(scriptPath);
  if (ext === ".ts") {
    const bunPath = await ensureBun();
    return { command: bunPath, args: ["run", scriptPath] };
  }
  return { command: scriptPath, args: [] };
}

export interface HookRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export async function runHookScript(
  hook: DiscoveredHook,
  eventData: HookEventData,
  options?: { timeoutMs?: number },
): Promise<HookRunResult> {
  const timeoutMs = options?.timeoutMs ?? 5000;

  let spawnResult: { command: string; args: string[] };
  try {
    spawnResult = await getSpawnArgs(hook.scriptPath);
  } catch (err) {
    return { exitCode: null, stdout: "", stderr: (err as Error).message };
  }
  const { command, args } = spawnResult;

  return new Promise<HookRunResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: hook.dir,
      env: {
        ...process.env,
        VELLUM_HOOK_EVENT: eventData.event,
        VELLUM_HOOK_NAME: hook.name,
        // @deprecated — usage of VELLUM_ROOT_DIR by hook scripts is deprecated.
        // Removing this requires an LLM-based migration or declarative migration
        // file to update existing user-authored hooks to use VELLUM_WORKSPACE_DIR.
        //
        // VELLUM_ROOT_DIR is kept at the legacy `~/.vellum` value even when
        // vellumRoot() resolves per-instance via BASE_DATA_DIR. User hook
        // scripts written against this env var expected the legacy path;
        // changing it would be a silent contract break. Hooks that need the
        // per-instance root should read BASE_DATA_DIR themselves or use the
        // new env vars the environment-layout plan adds.
        VELLUM_ROOT_DIR: join(homedir(), ".vellum"),
        VELLUM_WORKSPACE_DIR: getWorkspaceDir(),
        VELLUM_HOOK_SETTINGS: JSON.stringify(
          getHookSettings(hook.name, hook.manifest),
        ),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      // Give the process a short grace period to exit after SIGTERM, then SIGKILL
      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 2000);
      child.once("close", () => {
        clearTimeout(killTimer);
        resolve({
          exitCode: null,
          stdout,
          stderr: stderr + "\nHook timed out",
        });
      });
    }, timeoutMs);

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: stderr + "\n" + err.message });
    });

    // Suppress unhandled EPIPE errors if the child exits before we finish writing
    child.stdin.on("error", () => {});
    // Write event data to stdin and close
    child.stdin.write(JSON.stringify(eventData));
    child.stdin.end();
  });
}
