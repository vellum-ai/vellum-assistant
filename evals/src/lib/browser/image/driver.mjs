// Single browser action for the jailed app-interaction image.
//
// Invoked once per action over `docker exec`, reading one action as JSON on
// stdin and printing one result as JSON on stdout. It attaches to the
// long-lived Chromium launched by `server.mjs` over CDP, operates on the
// browser's existing page so state persists across invocations, and
// disconnects (the CDP client closes; the browser keeps running).
//
// Elements are targeted by ARIA role + accessible name, matching the
// observation `observe` returns, so actions reference what the simulator
// saw rather than brittle CSS selectors or pixel coordinates.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const STATE_DIR = "/state";
const VIEWPORT = { width: 1280, height: 800 };

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function readConsoleErrors() {
  try {
    return JSON.parse(readFileSync(`${STATE_DIR}/console.json`, "utf8"));
  } catch {
    return [];
  }
}

function locate(page, action) {
  const locator = page.getByRole(action.role, {
    name: action.name,
    exact: true,
  });
  return action.nth === undefined ? locator : locator.nth(action.nth);
}

async function runAction(page, action) {
  switch (action.kind) {
    case "load":
      await page.setViewportSize(VIEWPORT);
      await page.setContent(action.html, { waitUntil: "load" });
      return { ok: true };
    case "observe":
      return {
        url: page.url(),
        snapshot: await page.locator("body").ariaSnapshot(),
        consoleErrors: readConsoleErrors(),
      };
    case "click":
      await locate(page, action).click();
      return { ok: true };
    case "type":
      await locate(page, action).fill(action.text);
      return { ok: true };
    case "press":
      await page.keyboard.press(action.key);
      return { ok: true };
    case "scroll":
      await page.mouse.wheel(action.dx ?? 0, action.dy ?? 0);
      return { ok: true };
    case "screenshot":
      await page.screenshot({ path: action.path });
      return { ok: true, path: action.path };
    default:
      return { error: `unknown action kind: ${String(action.kind)}` };
  }
}

async function main() {
  const action = JSON.parse(process.argv[2] ?? (await readStdin()));
  const endpoint = readFileSync(`${STATE_DIR}/cdp-endpoint`, "utf8").trim();
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    const result = await runAction(page, action);
    process.stdout.write(JSON.stringify(result) + "\n");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({ error: String(error) }) + "\n");
  process.exit(1);
});
