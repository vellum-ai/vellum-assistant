import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runHookScript } from "../hooks/runner.js";
import type {
  DiscoveredHook,
  HookEventData,
  HookManifest,
} from "../hooks/types.js";

let hooksDir: string;

function createHook(
  name: string,
  scriptName: string,
  scriptContent: string,
): DiscoveredHook {
  const hookDir = join(hooksDir, name);
  mkdirSync(hookDir, { recursive: true });

  const manifest: HookManifest = {
    name,
    description: `Test hook: ${name}`,
    version: "1.0.0",
    events: ["pre-llm-call"],
    script: scriptName,
  };

  writeFileSync(join(hookDir, "hook.json"), JSON.stringify(manifest));

  const scriptPath = join(hookDir, scriptName);
  writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

  return {
    name,
    dir: hookDir,
    manifest,
    scriptPath,
    enabled: true,
  };
}

describe("TypeScript hooks runner", () => {
  beforeEach(() => {
    hooksDir = join(
      tmpdir(),
      `hooks-ts-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(hooksDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(hooksDir, { recursive: true, force: true });
  });

  test("[experimental] runs .ts hook via bun run", async () => {
    const hook = createHook(
      "ts-hook",
      "run.ts",
      `
const chunks: Buffer[] = [];
for await (const chunk of Bun.stdin.stream()) {
  chunks.push(Buffer.from(chunk));
}
const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
console.log(JSON.stringify({ event: data.event, ok: true }));
`,
    );

    const eventData: HookEventData = { event: "pre-llm-call", model: "test" };
    const result = await runHookScript(hook, eventData);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.event).toBe("pre-llm-call");
    expect(output.ok).toBe(true);
  });

  test("[experimental] .ts hook receives event data on stdin", async () => {
    const hook = createHook(
      "stdin-hook",
      "handler.ts",
      `
const chunks: Buffer[] = [];
for await (const chunk of Bun.stdin.stream()) {
  chunks.push(Buffer.from(chunk));
}
const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
console.log(data.customField);
`,
    );

    const eventData: HookEventData = {
      event: "pre-llm-call",
      customField: "hello-ts",
    };
    const result = await runHookScript(hook, eventData);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello-ts");
  });

  test(".ts hook receives env vars", async () => {
    const hook = createHook(
      "env-hook",
      "check-env.ts",
      `
console.log(process.env.VELLUM_HOOK_EVENT);
console.log(process.env.VELLUM_HOOK_NAME);
`,
    );

    const eventData: HookEventData = { event: "pre-llm-call" };
    const result = await runHookScript(hook, eventData);

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).toBe("pre-llm-call");
    expect(lines[1]).toBe("env-hook");
  });

  test(".ts hook non-zero exit returns exit code", async () => {
    const hook = createHook(
      "fail-hook",
      "fail.ts",
      `
process.exit(1);
`,
    );

    const eventData: HookEventData = { event: "pre-llm-call" };
    const result = await runHookScript(hook, eventData);

    expect(result.exitCode).toBe(1);
  });

  test(".sh hook still runs directly (not via bun)", async () => {
    const hook = createHook(
      "sh-hook",
      "run.sh",
      `#!/bin/sh
echo "shell-hook"
`,
    );

    const eventData: HookEventData = { event: "pre-llm-call" };
    const result = await runHookScript(hook, eventData);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("shell-hook");
  });

  test(".ts hook can write to stderr", async () => {
    const hook = createHook(
      "stderr-hook",
      "log.ts",
      `
console.error('ts-stderr-output');
`,
    );

    const eventData: HookEventData = { event: "pre-llm-call" };
    const result = await runHookScript(hook, eventData);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("ts-stderr-output");
  });
});
