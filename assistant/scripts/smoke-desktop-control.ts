import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  desktopActionSchema,
  runDesktopCommand,
  X11DesktopInput,
} from "../src/desktop/desktop-input.js";

if (process.platform !== "linux") {
  throw new Error(
    "Run this smoke test in a disposable Linux environment with TigerVNC, xwd, xdotool and python3-tk installed",
  );
}

import { DESKTOP_OVERRIDABLE_PARAMETERS } from "../src/desktop/desktop-display.js";

const directory = await mkdtemp(join(tmpdir(), "desktop-input-smoke-"));
const resultPath = join(directory, "form.json");
const children: ReturnType<typeof Bun.spawn>[] = [];
const signal = AbortSignal.timeout(30_000);
const input = new X11DesktopInput();
const start = (cmd: string[]) => {
  const child = Bun.spawn(cmd, {
    env: { PATH: "/usr/bin:/bin", DISPLAY: ":99", LANG: "C.UTF-8" },
    stdout: "ignore",
    stderr: "inherit",
    windowsHide: true,
  });
  children.push(child);
  return child;
};
const waitFor = async (predicate: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    signal.throwIfAborted();
    if (await predicate().catch(() => false)) {
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error(
    `Desktop smoke condition timed out: ${await readFile(resultPath, "utf8").catch(() => "no form state")}`,
  );
};
const state = async () =>
  JSON.parse(await readFile(resultPath, "utf8")) as {
    text: string;
    saved: string;
    scroll: number;
    released: boolean;
    motion: { x: number; y: number; time: number; down: boolean }[];
  };
const act = (value: Record<string, unknown>) =>
  input.perform(
    desktopActionSchema.parse({
      observation_id: crypto.randomUUID(),
      ...value,
    }),
    signal,
  );

try {
  start([
    "Xtigervnc",
    ":99",
    "-localhost",
    "-SecurityTypes",
    "None",
    "-AllowOverride",
    DESKTOP_OVERRIDABLE_PARAMETERS.join(","),
    "-geometry",
    "1440x900",
    "-depth",
    "24",
  ]);
  await waitFor(
    async () =>
      (await runDesktopCommand("xdotool", ["getdisplaygeometry"])).length > 0,
  );
  const fixture = join(directory, "form.py");
  await writeFile(
    fixture,
    `import tkinter as tk, json, sys, time
r = tk.Tk()
r.overrideredirect(True)
r.geometry("600x400+0+0")
r.configure(background="white")
entry = tk.Entry(r, font=("sans", 20))
entry.place(x=20, y=20, width=400, height=40)
saved = ""
scroll = 0
released = False
motion = []
def moved(event):
    motion.append(dict(x=event.x_root, y=event.y_root, time=time.monotonic(), down=bool(event.state & 256)))
r.bind("<Motion>", moved)
def key_release(event):
    global released
    if event.keysym == "F8":
        released = True
r.bind("<KeyRelease>", key_release)
def save():
    global saved
    saved = entry.get()
tk.Button(r, text="Save", command=save).place(x=20, y=80, width=120, height=40)
def wheel(event):
    global scroll
    scroll += 1
r.bind("<Button-4>", wheel)
r.bind("<Button-5>", wheel)
def report():
    with open(sys.argv[1], "w") as f:
        json.dump(dict(text=entry.get(), saved=saved, scroll=scroll, released=released, motion=motion), f)
    r.after(20, report)
r.after(100, lambda: entry.focus_force())
report()
r.mainloop()
`,
  );
  start(["python3", fixture, resultPath]);
  await waitFor(async () => (await state()).text === "");
  console.log("Form started");
  await input.setViewerInput(false);
  const before = await input.observe(signal);
  assert.equal(before.width, 1440);
  assert.equal(before.height, 900);
  await runDesktopCommand("xdotool", ["mousemove", "100", "300"]);
  await waitFor(async () => (await state()).motion.at(-1)?.x === 100);
  const motionStart = (await state()).motion.length;
  await act({ action: "drag", x: 100, y: 300, to_x: 500, to_y: 300 });
  await waitFor(async () => (await state()).motion.at(-1)?.x === 500);
  const motion = (await state()).motion.slice(motionStart);
  assert(motion.length >= 5, "Drag must emit intermediate pointer positions");
  assert(motion.every((point) => point.down && point.y === 300));
  assert(motion[0]!.x > 100 && motion[0]!.x < 500);
  assert(motion.at(-1)!.time - motion[0]!.time >= 0.075);
  console.log(`Verified smooth drag: ${motion.length} timed pointer positions`);
  await act({ action: "click", x: 40, y: 40 });
  await act({ action: "type", text: "Hello café 世界" });
  console.log("Typed Unicode");
  await waitFor(async () => (await state()).text === "Hello café 世界");
  console.log("Verified Unicode");
  await act({ action: "click", x: 40, y: 100 });
  await waitFor(async () => (await state()).saved === "Hello café 世界");
  await act({ action: "scroll", x: 200, y: 200, direction: "down", amount: 3 });
  await waitFor(async () => (await state()).scroll === 3);
  await act({ action: "drag", x: 40, y: 40, to_x: 200, to_y: 40 });
  await input.releaseInput();
  await act({ action: "key", key: "Home" });
  await act({ action: "key", key: "shift+End" });
  await act({ action: "type", text: "replacement" });
  await waitFor(async () => (await state()).text === "replacement");
  await runDesktopCommand("xdotool", [
    "keydown",
    "F8",
    "keydown",
    "Shift_L",
    "mousedown",
    "1",
  ]);
  await input.releaseInput();
  await waitFor(async () => (await state()).released);
  await act({ action: "key", key: "End" });
  const after = await input.observe(signal);
  assert.notDeepEqual(before.png, after.png);
  await writeFile(join(tmpdir(), "desktop-control-smoke.png"), after.png);

  // A real RFB viewer must be unable to type while automation owns input.
  const viewer = createConnection({ host: "127.0.0.1", port: 5999 });
  let pending = Buffer.alloc(0);
  viewer.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
  });
  const read = async (length: number) => {
    await waitFor(async () => pending.length >= length);
    const data = pending.subarray(0, length);
    pending = pending.subarray(length);
    return data;
  };
  try {
    await read(12);
    viewer.write("RFB 003.008\n");
    const count = (await read(1))[0]!;
    assert((await read(count)).includes(1));
    viewer.write(Buffer.from([1]));
    assert.equal((await read(4)).readUInt32BE(), 0);
    viewer.write(Buffer.from([1]));
    const init = await read(24);
    await read(init.readUInt32BE(20));
    const key = Buffer.from([
      4, 1, 0, 0, 0, 0, 0, 120, 4, 0, 0, 0, 0, 0, 0, 120,
    ]);
    viewer.write(key);
    await Bun.sleep(100);
    assert.equal((await state()).text, "replacement");
    await input.setViewerInput(true);
    viewer.write(key);
    await waitFor(async () => (await state()).text === "replacementx");
    await input.setViewerInput(false);
    viewer.write(key);
    await Bun.sleep(100);
    assert.equal((await state()).text, "replacementx");
    await input.setViewerInput(true);
    viewer.write(key);
    await waitFor(async () => (await state()).text === "replacementxx");
  } finally {
    viewer.destroy();
  }
  console.log(
    "PASS: real X11 screenshots, smooth pointer motion, Unicode typing, clicks, keyboard shortcuts, scrolling, dragging, and RFB input takeover",
  );
} finally {
  for (const child of children.reverse()) {
    child.kill();
  }
  await Promise.all(children.map((child) => child.exited));
  await rm(directory, { recursive: true, force: true });
}
