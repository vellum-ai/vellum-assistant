import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeDesktopWindowTheme } from "../src/desktop/desktop-window-theme.js";

if (process.platform !== "linux") {
  throw new Error(
    "Run in a disposable Linux environment with Xvfb, Openbox, xterm, xdotool, xwininfo and xmllint installed",
  );
}

const directory = await mkdtemp(join(tmpdir(), "window-theme-smoke-"));
const env = { ...process.env, DISPLAY: ":97" };
const children: ReturnType<typeof Bun.spawn>[] = [];
const start = (cmd: string[]) => {
  const child = Bun.spawn(cmd, {
    env,
    stdout: "ignore",
    stderr: "inherit",
    windowsHide: true,
  });
  children.push(child);
  return child;
};
const run = (...cmd: string[]) => {
  const result = Bun.spawnSync(cmd, {
    env,

    windowsHide: true,
  });
  assert.equal(result.exitCode, 0, result.stderr.toString());
  return result.stdout.toString();
};
const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if (predicate()) {
        return;
      }
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error("Window theme smoke condition timed out");
};
const pointer = async (...args: string[]) => {
  run("xdotool", ...args);
  await Bun.sleep(200);
};
const geometry = () => {
  const info = run("xwininfo", "-name", "Theme smoke");
  return [
    "Absolute upper-left X",
    "Absolute upper-left Y",
    "Width",
    "Height",
  ].map((label) =>
    Number(new RegExp(`${label}:\\s+(-?\\d+)`).exec(info)?.[1]),
  ) as [number, number, number, number];
};
const state = () => run("xprop", "-name", "Theme smoke", "_NET_WM_STATE");
const button = async (offset: number) => {
  const [x, y, width] = geometry();
  await pointer(
    "mousemove",
    String(x + width - offset),
    String(y - 16),
    "click",
    "1",
  );
};

try {
  const home = join(directory, "home");
  const sourceDir = join(home, ".config", "openbox");
  await mkdir(sourceDir, { recursive: true });
  const original = await readFile("/etc/xdg/openbox/rc.xml", "utf8");
  const mouse = original.match(/<mouse>[^]*?<\/mouse>/)![0];
  const keyboard = original.match(/<keyboard>[^]*?<\/keyboard>/)![0];
  const source = original
    .replace(
      mouse,
      `<xi:include href="bindings.xml" xpointer="xpointer(/*/*)"/>`,
    )
    .replace(keyboard, "");
  const sourcePath = join(sourceDir, "rc.xml");
  await writeFile(sourcePath, source);
  await writeFile(
    join(sourceDir, "bindings.xml"),
    `<bindings xmlns="http://openbox.org/3.4/rc">${mouse}${keyboard}</bindings>`,
  );
  const configDir = join(directory, "managed & theme");
  const config = writeDesktopWindowTheme(configDir, home, "#53b7aa");
  const expanded = run("xmllint", "--xinclude", config);
  assert(
    expanded.includes("NextWindow") && expanded.includes("Move"),
    "Relative includes must retain the actual keyboard and mouse bindings",
  );
  assert.equal(await readFile(sourcePath, "utf8"), source);
  writeDesktopWindowTheme(configDir, home, "#bc7799");
  writeDesktopWindowTheme(configDir, home, "#53b7aa");
  assert.equal(await readFile(sourcePath, "utf8"), source);
  const blocked = join(directory, "blocked");
  await writeFile(blocked, "not a directory");
  assert.throws(() => writeDesktopWindowTheme(blocked, home));
  assert.equal(await readFile(sourcePath, "utf8"), source);
  const customBase = source.replace(
    "<openbox_config",
    '<openbox_config xml:base="./custom/"',
  );
  await writeFile(sourcePath, customBase);
  assert.throws(() => writeDesktopWindowTheme(configDir, home));
  assert.equal(await readFile(sourcePath, "utf8"), customBase);
  await writeFile(sourcePath, source);

  start(["Xvfb", ":97", "-screen", "0", "1100x700x24"]);
  await waitFor(
    () => run("xdotool", "getdisplaygeometry").trim() === "1100 700",
  );
  start(["openbox", "--config-file", config]);
  await waitFor(() =>
    run("xprop", "-root", "_OB_THEME").includes("window-theme"),
  );
  start([
    "xterm",
    "-title",
    "Theme smoke",
    "-geometry",
    "48x12+450+250",
    "-e",
    "sleep",
    "60",
  ]);
  await waitFor(
    () => run("xdotool", "search", "--name", "^Theme smoke$").trim().length > 0,
  );
  await Bun.sleep(300);
  const id = run("xdotool", "search", "--name", "^Theme smoke$").trim();
  await button(39);
  assert(
    state().includes("MAXIMIZED_HORZ") && state().includes("MAXIMIZED_VERT"),
  );
  await button(39);
  assert(!state().includes("MAXIMIZED"));
  await button(62);
  assert(state().includes("HIDDEN"));
  await pointer("windowactivate", id);
  assert(!state().includes("HIDDEN"));
  let [x, y, width, height] = geometry();
  await pointer("mousemove", String(x + 100), String(y - 16), "mousedown", "1");
  await pointer("mousemove", String(x + 90), String(y - 26));
  await pointer("mousemove", String(x + 45), String(y - 65));
  await pointer("mouseup", "1");
  const [movedX, movedY] = geometry();
  assert(Math.abs(movedX - x) >= 30 && Math.abs(movedY - y) >= 30);
  [x, y, width, height] = geometry();
  await pointer(
    "mousemove",
    String(x + width - 2),
    String(y + height + 2),
    "mousedown",
    "1",
  );
  await pointer("mousemove", String(x + width + 10), String(y + height + 10));
  await pointer("mousemove", String(x + width + 60), String(y + height + 40));
  await pointer("mouseup", "1");
  const [, , resizedWidth, resizedHeight] = geometry();
  assert(resizedWidth > width && resizedHeight > height);
  await pointer("key", "alt+F4");
  await waitFor(
    () =>
      !run("xprop", "-root", "_NET_CLIENT_LIST").includes(
        `0x${Number(id).toString(16)}`,
      ),
  );
  console.log(
    "PASS: relative includes, preserved source, repeated theme updates, maximize/restore, minimize/activation, dragging, resizing, and keyboard close",
  );
} finally {
  for (const child of children.reverse()) {
    child.kill();
  }
  await Promise.all(children.map((child) => child.exited));
  await rm(directory, { recursive: true, force: true });
}
