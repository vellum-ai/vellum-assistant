import { strict as assert } from "node:assert";

import { DesktopBrowser } from "../src/desktop/desktop-browser.js";
import { desktopBrowserBridge } from "../src/desktop/desktop-browser-bridge.js";
import {
  desktopChromePath,
  desktopDependencyInstaller,
} from "../src/desktop/desktop-dependencies.js";
import {
  desktopExtensionAsset,
  ensureDesktopExtension,
} from "../src/desktop/desktop-extension.js";

if (
  process.platform !== "linux" ||
  !process.env.VELLUM_WORKSPACE_DIR?.startsWith("/tmp/")
) {
  throw new Error(
    "Run in an isolated Linux container with a temporary workspace",
  );
}
const server = Bun.serve({
  port: 7830,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.endsWith("/update") || path.endsWith("/package")) {
      console.log("Chrome requested", path);
    }
    if (path === "/v1/desktop/browser/bridge") {
      try {
        return Response.json(
          await desktopBrowserBridge.exchange(await req.json(), "user-123"),
        );
      } catch {
        return new Response("Rejected", { status: 403 });
      }
    }
    if (
      path === "/v1/desktop/browser/update" ||
      path === "/v1/desktop/browser/package"
    ) {
      const asset = desktopExtensionAsset(
        path.endsWith("update") ? "update" : "package",
      );
      return new Response(Buffer.from(asset.data, "base64"), {
        headers: { "Content-Type": asset.contentType },
      });
    }
    return new Response(
      '<!doctype html><title>Desktop browser smoke</title><p>Example reading content</p><button onclick="this.textContent = \'Clicked once\';this.disabled=true">Click me</button><input aria-label="Example field">',
      { headers: { "Content-Type": "text/html" } },
    );
  },
});
const children: ReturnType<typeof Bun.spawn>[] = [];
try {
  await desktopDependencyInstaller.ensureReady();
  console.log("Desktop dependencies ready");
  await ensureDesktopExtension({
    chromePath: desktopChromePath(),
    profileDir: "/tmp/vellum-extension-profile",
  });
  console.log("Managed extension provisioned");
  children.push(
    Bun.spawn(
      [
        "Xtigervnc",
        ":99",
        "-SecurityTypes",
        "None",
        "-localhost",
        "yes",
        "-rfbport",
        "5900",
        "-geometry",
        "1280x800",
      ],
      { windowsHide: true, stdout: "ignore", stderr: "inherit" },
    ),
  );
  await Bun.sleep(1000);
  children.push(
    Bun.spawn(
      [
        desktopChromePath(),
        "--no-sandbox",
        "--no-first-run",
        "--disable-dev-shm-usage",
        "--user-data-dir=/tmp/vellum-extension-profile",
        "http://127.0.0.1:7830/example",
      ],
      {
        windowsHide: true,
        env: { ...process.env, DISPLAY: ":99" },
        stdout: "ignore",
        stderr: "inherit",
      },
    ),
  );
  const browser = new DesktopBrowser();
  const execute = (action: Record<string, unknown>) =>
    browser.execute(
      { scope: "browser", ...action },
      "user-123",
      "conv-123",
      AbortSignal.timeout(15_000),
    );
  let observed: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      observed = await execute({ action: "observe" });
      break;
    } catch (err) {
      if (attempt === 89) {
        throw err;
      }
      await Bun.sleep(1000);
    }
  }
  assert(observed);
  assert(String(observed.text).includes("Example reading content"));
  const elements = observed.elements as { eid: string; name: string }[];
  const button = elements.find((element) => element.name === "Click me");
  assert(button);
  const clicked = await execute({
    action: "click",
    element: button.eid,
    observation_id: observed.observation_id,
  });
  assert(JSON.stringify(clicked).includes("Clicked once"));
  assert(clicked.observation_id !== observed.observation_id);
  await assert.rejects(
    execute({
      action: "click",
      element: button.eid,
      observation_id: observed.observation_id,
    }),
  );
  await browser.release();
  console.log(
    "PASS: signed policy install, native bootstrap, page reading, semantic click, and stale-reference rejection in visible Chrome on :99",
  );
} finally {
  desktopBrowserBridge.stop();
  for (const child of children.reverse()) {
    child.kill();
  }
  server.stop(true);
}
