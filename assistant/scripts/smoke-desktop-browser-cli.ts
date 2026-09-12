import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IpcFrameReader, writeMessage } from "@vellumai/ipc-server-utils";
import { Command } from "commander";

import { executeBrowserOperation } from "../src/browser/operations.js";
import type { BrowserOperation } from "../src/browser/types.js";
import { registerBrowserCommand } from "../src/cli/commands/browser.js";
import { DesktopControl } from "../src/desktop/desktop-control.js";
import { X11DesktopInput } from "../src/desktop/desktop-input.js";
import { DesktopSessionManager } from "../src/desktop/desktop-session-manager.js";
import { getAssistantSocketPath } from "../src/ipc/socket-path.js";

if (
  process.platform !== "linux" ||
  !process.argv[2] ||
  !process.env.ASSISTANT_IPC_SOCKET_DIR
) {
  throw new Error(
    "Run in disposable Linux with desktop packages, a temporary ASSISTANT_IPC_SOCKET_DIR and a Chrome executable argument.",
  );
}
const executable = process.argv[2];
const directory = await mkdtemp(join(tmpdir(), "desktop-browser-cli-"));
const input = new X11DesktopInput();
const manager = new DesktopSessionManager({
  resolveChromePath: async () => executable,
  profileDir: join(directory, "profile"),
  panelConfigDir: join(directory, "panel"),
  renderWallpaper: async () => null,
});
const control = new DesktopControl({
  enabled: () => true,
  ready: () => true,
  manager: () => manager,
  input,
  notify: async () => {},
});
const context = {
  workingDir: directory,
  conversationId: "conv-smoke",
  sourceActorPrincipalId: "user-123",
  trustClass: "guardian" as const,
};
let submissions = 0;
const page = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname === "/save") {
      submissions++;
      return Response.json({ ok: true });
    }
    return new Response(
      `<!doctype html><html><head><title>Desktop browser CLI</title><style>body{font:24px sans-serif;padding:70px;background:#f3f4f8}input,button{font:inherit;padding:12px;margin:16px}#result{color:#5140bd}</style></head><body><h1>Streamed desktop browser</h1><label>Example text<input id="text"></label><button id="save" onclick="fetch('/save');document.getElementById('result').textContent='Saved '+document.getElementById('text').value">Save</button><p id="result"></p></body></html>`,
      {
        headers: {
          "content-type": "text/html",
          "content-security-policy":
            "require-trusted-types-for 'script'; trusted-types 'none'",
        },
      },
    );
  },
});
await mkdir(process.env.ASSISTANT_IPC_SOCKET_DIR, { recursive: true });
const ipc = createServer((socket) => {
  const reader = new IpcFrameReader((request) => {
    void (async () => {
      try {
        const body = (
          request.params as {
            body: {
              operation: BrowserOperation;
              input: Record<string, unknown>;
              desktop: boolean;
            };
          }
        ).body;
        assert.equal(request.method, "browser_execute");
        assert.equal(body.desktop, true);
        const result = await control.runBrowser(
          context,
          async (signal) => {
            const cdpClient = await manager.browser.client(
              context.conversationId,
              signal,
            );
            return executeBrowserOperation(body.operation, body.input, {
              ...context,
              signal,
              cdpClient,
            });
          },
          body.operation === "detach",
        );
        writeMessage(socket, { id: request.id, result });
      } catch (error) {
        writeMessage(socket, { id: request.id, error: String(error) });
      }
    })();
  });
  socket.on("data", (chunk) => reader.push(chunk));
});
await new Promise<void>((resolve, reject) => {
  ipc.once("error", reject);
  ipc.listen(getAssistantSocketPath(), resolve);
});
async function cli(...args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerBrowserCommand(program);
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof original;
  try {
    await program.parseAsync([
      "bun",
      "assistant",
      "browser",
      "--desktop",
      "--json",
      ...args,
    ]);
  } finally {
    process.stdout.write = original;
  }
  const result = JSON.parse(chunks.join("")) as {
    ok: boolean;
    content: string;
    error?: string;
  };
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.content;
}
function ref(snapshot: string, name: string): string {
  const line = snapshot
    .split("\n")
    .find((value) => value.includes(name) && /\be\d+\b/.test(value));
  assert(line, `Missing ${name}: ${snapshot}`);
  return /\be\d+\b/.exec(line)![0];
}
try {
  await cli(
    "navigate",
    "--url",
    `http://127.0.0.1:${page.port}`,
    "--allow-private-network",
  );
  const snapshot = await cli("snapshot");
  await cli(
    "type",
    "--element-id",
    ref(snapshot, "Example text"),
    "--text",
    "Hello café 世界",
    "--clear-first",
  );
  await cli("click", "--element-id", ref(snapshot, "Save"));
  const saved = await cli("extract");
  assert.match(saved, /Saved Hello café 世界/);
  assert.equal(submissions, 1);
  await control.runBrowser(context, async (signal) => {
    const cdp = await manager.browser.client(context.conversationId, signal);
    const pointer = await cdp.send<{ result: { value: boolean } }>(
      "Runtime.evaluate",
      {
        expression: "!!document.querySelector('[data-vellum-desktop-cursor]')",
      },
    );
    assert.equal(pointer.result.value, true);
    await writeFile(
      join(tmpdir(), "desktop-browser-cli-smoke.png"),
      (await input.observe(signal)).png,
    );
    return { content: "verified", isError: false };
  });
  await cli("detach");
  assert.equal(control.getStatus().state, "idle");
  await control.runBrowser(context, async (signal) => {
    const cdp = await manager.browser.client(context.conversationId, signal);
    const pointer = await cdp.send<{ result: { value: boolean } }>(
      "Runtime.evaluate",
      {
        expression: "!!document.querySelector('[data-vellum-desktop-cursor]')",
      },
    );
    assert.equal(pointer.result.value, false);
    return { content: "verified", isError: false };
  });
  await control.takeControl();
  console.log(
    "PASS: real browser CLI over IPC, shared AX snapshot, Unicode typing, one click submission, visible cursor, detach cleanup and takeover",
  );
} finally {
  await control.takeControl();
  await manager.destroy();
  await new Promise<void>((resolve) => ipc.close(() => resolve()));
  page.stop(true);
  await rm(directory, { recursive: true, force: true });
}
