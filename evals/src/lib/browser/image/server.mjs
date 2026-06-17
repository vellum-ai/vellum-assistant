// Long-lived browser process for the jailed app-interaction image.
//
// Launches headless Chromium with a CDP endpoint bound to loopback, then
// stays alive so a sequence of short-lived `driver.mjs` invocations can
// attach to the same browser over CDP and share page state across actions
// (a fresh `connectOverCDP` client per action; the browser itself is never
// torn down until the container stops).
//
// Two files under `/state` form the contract with the host:
//   - `cdp-endpoint`  — the CDP base URL, written once Chromium is
//     listening; the host polls for it as the readiness signal and each
//     driver reads it to connect.
//   - `console.json`  — accumulated page console errors and uncaught
//     exceptions, refreshed as they occur so `observe` can surface them.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const CDP_PORT = 9222;
const STATE_DIR = "/state";
const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;

mkdirSync(STATE_DIR, { recursive: true });

const browserProcess = spawn(
  chromium.executablePath(),
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    `--remote-debugging-port=${CDP_PORT}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${STATE_DIR}/chrome-profile`,
    "about:blank",
  ],
  { stdio: "inherit" },
);

async function waitForCdp() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const res = await fetch(`${CDP_ENDPOINT}/json/version`);
      if (res.ok) return;
    } catch {
      // CDP not listening yet; retry until the budget runs out.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chromium CDP endpoint did not come up");
}

await waitForCdp();

const consoleErrors = [];
function flushConsoleErrors() {
  try {
    writeFileSync(`${STATE_DIR}/console.json`, JSON.stringify(consoleErrors));
  } catch {
    // Best-effort: a failed write only loses console diagnostics, never
    // the browser session itself.
  }
}
flushConsoleErrors();

function watchPage(page) {
  page.on("pageerror", (error) => {
    consoleErrors.push(String(error));
    flushConsoleErrors();
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
      flushConsoleErrors();
    }
  });
}

// A dedicated long-lived CDP client owns the console/error listeners. A
// per-action driver's listeners would only see events during that action's
// brief connection, so error capture has to live on a connection that
// outlives every action.
const monitor = await chromium.connectOverCDP(CDP_ENDPOINT);
const monitorContext = monitor.contexts()[0] ?? (await monitor.newContext());
monitorContext.on("page", watchPage);
monitorContext.pages().forEach(watchPage);

writeFileSync(`${STATE_DIR}/cdp-endpoint`, CDP_ENDPOINT);
console.log("BROWSER_SERVER_READY");

process.on("SIGTERM", () => {
  browserProcess.kill("SIGTERM");
  process.exit(0);
});

await new Promise(() => {});
