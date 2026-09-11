import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  connectDesktopBrowser,
  DesktopBrowser,
  desktopBrowserActionSchema,
} from "../src/desktop/desktop-browser.js";
import {
  allocateDesktopDebugPort,
  assertDesktopListener,
  desktopChromeArguments,
  validateDesktopWebSocket,
} from "../src/desktop/desktop-browser-endpoint.js";

const executable = process.argv[2];
if (!executable) {
  throw new Error(
    "Usage: bun scripts/smoke-desktop-browser.ts /path/to/chrome. Uses a disposable profile; add --headed to use the current DISPLAY. Linux also verifies listener ownership.",
  );
}
const profile = await mkdtemp(join(tmpdir(), "desktop-browser-smoke-"));
const port = await allocateDesktopDebugPort();
let submits = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname === "/submit") {
      submits += 1;
      return Response.json({ ok: true });
    }
    return new Response(
      `<!doctype html><title>Browser smoke fixture</title>
      <p>Useful page reading text</p>
      <label>Example text<input id="text"></label>
      <button id="submit" onclick="fetch('/submit');document.querySelector('#result').textContent='Saved '+document.querySelector('#text').value">Save</button>
      <button disabled>Disabled</button>
      <div style="position:relative;width:180px;height:60px"><button style="width:180px;height:60px">Covered</button><div style="position:absolute;inset:0;background:black"></div></div>
      <button id="move" style="animation: move .1s infinite alternate linear">Moving</button>
      <style>@keyframes move {from {transform:translateX(0)} to {transform:translateX(300px)}}</style>
      <p id="result"></p>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
const child = Bun.spawn(
  [
    executable,
    ...desktopChromeArguments(profile, port),
    ...(process.argv.includes("--headed") ? [] : ["--headless=new"]),
    "--no-proxy-server",
    "--disable-background-networking",
    `http://127.0.0.1:${server.port}`,
  ],
  { stdout: "ignore", stderr: "ignore", windowsHide: true },
);
const signal = AbortSignal.timeout(30_000);
const browser = new DesktopBrowser(async (connectSignal) => {
  while (true) {
    connectSignal.throwIfAborted();
    try {
      if (process.platform === "linux") {
        await assertDesktopListener(child.pid, port);
      }
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: connectSignal,
        redirect: "error",
      });
      const version = (await response.json()) as {
        webSocketDebuggerUrl: string;
      };
      return await connectDesktopBrowser(
        validateDesktopWebSocket(version.webSocketDebuggerUrl, port),
        connectSignal,
      );
    } catch {
      await Bun.sleep(100);
    }
  }
});
type State = Record<string, unknown>;
let state: State;
const act = async (input: Record<string, unknown>) => {
  state = await browser.execute(
    desktopBrowserActionSchema.parse({
      observation_id: state?.observation_id,
      ...input,
    }),
    signal,
  );
  assert.equal(state.error, undefined, JSON.stringify(state));
  return state;
};
const ref = (name: string) => {
  const elements = state.elements as { eid: string; name: string }[];
  const element = elements.find((item) => item.name === name);
  assert.ok(element, `Missing ${name}: ${JSON.stringify(state)}`);
  return element.eid;
};
try {
  const tabs = await act({ action: "tabs" });
  const target = (tabs.tabs as { target_id: string }[])[0]!.target_id;
  await act({ action: "observe", target_id: target });
  assert.match(String(state!.text), /Useful page reading text/);
  await act({ action: "type", ref: ref("Example text"), text: "hello" });
  await act({ action: "click", ref: ref("Save") });
  assert.match(String(state!.text), /Saved hello/);
  assert.equal(submits, 1);
  for (const name of ["Disabled", "Covered", "Moving"]) {
    await act({ action: "observe" });
    const result = await browser.execute(
      {
        action: "click",
        observation_id: String(state!.observation_id),
        ref: ref(name),
      },
      signal,
    );
    assert.ok(result.error, `${name} should be rejected`);
  }
  await act({ action: "observe" });
  const old = String(state!.observation_id);
  await act({
    action: "navigate",
    url: `http://127.0.0.1:${server.port}/second`,
  });
  const stale = await browser.execute(
    { action: "click", observation_id: old, ref: "e1" },
    signal,
  );
  assert.equal(stale.outcome, "not_dispatched");
  await act({ action: "observe" });
  await act({ action: "new_tab" });
  assert.notEqual(state!.target_id, target);
  await act({ action: "close_tab" });
  await act({ action: "observe", target_id: target });
  assert.equal(submits, 1);
  if (process.platform === "linux") {
    await assert.rejects(assertDesktopListener(process.pid, port));
  }
  console.log(
    "PASS: reading, semantic typing/click, disabled/covered/moving controls, navigation, stale refs, new/close/select tabs and exactly one submission",
  );
} finally {
  await browser.release();
  child.kill();
  await Promise.race([child.exited, Bun.sleep(3_000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await child.exited;
  }
  server.stop(true);
  await rm(profile, { recursive: true, force: true });
}
