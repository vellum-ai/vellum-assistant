import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IpcFrameReader, writeMessage } from "@vellumai/ipc-server-utils";
import { Command } from "commander";
import sharp from "sharp";

import { executeBrowserOperation } from "../src/browser/operations.js";
import type { BrowserOperation } from "../src/browser/types.js";
import { registerBrowserCommand } from "../src/cli/commands/browser.js";
import { DesktopAutomationLease } from "../src/desktop/desktop-automation-lease.js";
import {
  desktopChromePath,
  desktopDependencyInstaller,
} from "../src/desktop/desktop-dependencies.js";
import { DesktopSessionManager } from "../src/desktop/desktop-session-manager.js";
import { getAssistantSocketPath } from "../src/ipc/socket-path.js";

if (
  process.platform !== "linux" ||
  !process.argv[2] ||
  !process.env.ASSISTANT_IPC_SOCKET_DIR
) {
  throw new Error(
    "Run in disposable Linux with desktop packages, a temporary ASSISTANT_IPC_SOCKET_DIR and a Chrome executable argument or --install for a cold install.",
  );
}
const coldInstall = process.argv[2] === "--install";
const executable = coldInstall ? desktopChromePath() : process.argv[2];
if (coldInstall) {
  assert.equal(desktopDependencyInstaller.getStatus().state, "required");
  assert.equal(Bun.which("Xtigervnc"), null);
}
const directory = await mkdtemp(join(tmpdir(), "desktop-browser-cli-"));
const manager = new DesktopSessionManager({
  resolveChromePath: async () => executable,
  profileDir: join(directory, "profile"),
  panelConfigDir: join(directory, "panel"),
  renderWallpaper: async () => null,
});
const control = new DesktopAutomationLease({
  notify: async () => {},
  enabled: () => true,
  ready: () =>
    !coldInstall || desktopDependencyInstaller.getStatus().state === "ready",
  ensureReady: (signal) => desktopDependencyInstaller.ensureReady(signal),
  manager: () => manager,
});
const context = {
  workingDir: directory,
  conversationId: "conv-smoke",
  sourceActorPrincipalId: "user-123",
  trustClass: "guardian" as const,
};
let submissions = 0;
let navigations = 0;
const page = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname === "/save") {
      submissions++;
      return Response.json({ ok: true });
    }
    if (new URL(request.url).pathname === "/") {
      navigations++;
    }
    return new Response(
      `<!doctype html><html><head><title>Desktop browser CLI</title><style>body{font:24px sans-serif;padding:70px;background:#f3f4f8}input,button{font:inherit;padding:12px;margin:16px}#result{color:#5140bd}#colors{position:fixed;left:0;top:0;display:flex}#colors span{width:100px;height:50px}</style></head><body><div id="colors"><span style="background:#ff0000"></span><span style="background:#00ff00"></span><span style="background:#0000ff"></span></div><h1>Streamed desktop browser</h1><label>Example text<input id="text"></label><button id="save" onclick="fetch('/save');document.getElementById('result').textContent='Saved '+document.getElementById('text').value">Save</button><p id="result"></p><button id="open-dialog" onclick="document.querySelector('dialog').showModal()">Open dialog</button><dialog style="background:white"><button id="inside" onclick="this.textContent='Modal clicked'">Inside dialog</button></dialog></body></html>`,
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
let setupNotifications = 0;
const ipc = createServer((socket) => {
  const reader = new IpcFrameReader((request) => {
    void (async () => {
      try {
        if (request.method === "/events/publish") {
          setupNotifications++;
          writeMessage(socket, { id: request.id, result: { ok: true } });
          return;
        }
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
        const screenshots = (result.contentBlocks ?? []).flatMap((block) =>
          block.type === "image" && block.source.type === "base64"
            ? [{ mediaType: block.source.media_type, data: block.source.data }]
            : [],
        );
        writeMessage(socket, {
          id: request.id,
          result: { ...result, screenshots },
        });
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
      "--virtual-desktop",
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
  assert.equal(navigations, 1);
  if (coldInstall) {
    assert.equal(desktopDependencyInstaller.getStatus().state, "ready");
    assert(
      setupNotifications >= 3,
      "Installation progress must reach the viewer",
    );
    console.error(
      "PASS: one CLI navigate installed desktop and Chrome from scratch, then loaded the requested page once",
    );
  }
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
  const screenshotPath = join(tmpdir(), "desktop-browser-cli-page.jpg");
  await cli("screenshot", "--output", screenshotPath);
  const { data: pixels, info } = await sharp(screenshotPath)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let channel = 0; channel < 3; channel++) {
    const offset = (25 * info.width + 50 + channel * 100) * info.channels;
    for (let component = 0; component < 3; component++) {
      const expected = component === channel ? 255 : 0;
      assert(
        Math.abs(pixels[offset + component] - expected) < 10,
        `Incorrect screenshot color for swatch ${channel}, channel ${component}`,
      );
    }
  }
  async function assertCursorPainted(expected: boolean) {
    await control.runBrowser(context, async (signal) => {
      const cdp = await manager.browser.client(context.conversationId, signal);
      const screenshot = await cdp.send<{ data: string }>(
        "Page.captureScreenshot",
        { format: "png" },
      );
      const { data, info } = await sharp(Buffer.from(screenshot.data, "base64"))
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      let purple = 0;
      for (let i = 0; i < data.length; i += info.channels) {
        if (
          Math.abs(data[i]! - 112) < 5 &&
          Math.abs(data[i + 1]! - 87) < 5 &&
          Math.abs(data[i + 2]! - 255) < 5
        ) {
          purple++;
        }
      }
      assert.equal(purple > 40, expected, `Cursor pixels: ${purple}`);
      return { content: "verified", isError: false };
    });
  }
  await assertCursorPainted(true);
  await cli("click", "--selector", "#open-dialog");
  await assertCursorPainted(true);
  await cli("hover", "--selector", "#inside");
  await assertCursorPainted(true);
  await cli("click", "--selector", "#inside");
  assert.match(await cli("extract"), /Modal clicked/);
  for (const key of ["Enter", "Space"]) {
    await cli("press-key", "--key", "Escape");
    await cli("press-key", "--key", key, "--selector", "#open-dialog");
    await assertCursorPainted(true);
  }
  await cli(
    "navigate",
    "--url",
    `http://127.0.0.1:${page.port}/next`,
    "--allow-private-network",
  );
  await assertCursorPainted(true);
  await cli("detach");
  await assertCursorPainted(false);
  await cli("detach");
  console.log(
    "PASS: real browser CLI over IPC, shared AX snapshot, Unicode typing, one click submission, RGB page screenshot, cursor pixels above dialogs and after navigation, detach cleanup",
  );
} finally {
  await cli("detach");
  await manager.destroy();
  await new Promise<void>((resolve) => ipc.close(() => resolve()));
  page.stop(true);
  await rm(directory, { recursive: true, force: true });
}
