import { expect, mock, test } from "bun:test";

import {
  desktopActionSchema,
  runDesktopCommand,
  X11DesktopInput,
} from "./desktop-input.js";

function fixture(x = 10, y = 20) {
  let down = false;
  let elapsed = 0;
  const moves: { x: number; y: number; down: boolean; elapsed: number }[] = [];
  const clicks: { x: number; y: number }[] = [];
  let onMove = () => {};
  const run = mock<typeof runDesktopCommand>(async (_command, args, signal) => {
    signal?.throwIfAborted();
    if (args[0] === "getdisplaygeometry") {
      return Buffer.from("1440 900");
    }
    if (args[0] === "getmouselocation") {
      return Buffer.from(`X=${x}\nY=${y}\nSCREEN=0\nWINDOW=0\n`);
    }
    if (args[0] === "click") {
      clicks.push({ x, y });
      return Buffer.alloc(0);
    }
    for (let index = 0; index < args.length; ) {
      signal?.throwIfAborted();
      const command = args[index++];
      switch (command) {
        case "sleep":
          elapsed += Number(args[index++]);
          break;
        case "mousemove":
          x = Number(args[index++]);
          y = Number(args[index++]);
          moves.push({ x, y, down, elapsed });
          onMove();
          break;
        case "mousedown":
        case "mouseup":
          down = command === "mousedown";
          index++;
          break;
        default:
          throw new Error(`Unexpected command: ${command}`);
      }
    }
    signal?.throwIfAborted();
    return Buffer.alloc(0);
  });
  const input = new X11DesktopInput(run);
  return {
    moves,
    clicks,
    input,
    isDown: () => down,
    onMove: (callback: () => void) => {
      onMove = callback;
    },
    act: (
      action: Record<string, unknown>,
      signal = new AbortController().signal,
    ) =>
      input.perform(
        desktopActionSchema.parse({
          observation_id: crypto.randomUUID(),
          ...action,
        }),
        signal,
      ),
  };
}

test("eases the pointer through intermediate positions and clicks only at the target", async () => {
  const f = fixture();
  await f.act({ action: "click", x: 1010, y: 520 });
  expect(f.moves.length).toBeGreaterThan(10);
  expect(f.clicks).toEqual([{ x: 1010, y: 520 }]);
  expect(f.moves.at(-1)).toMatchObject({ x: 1010, y: 520, down: false });
  let previous = { x: 10, y: 20, elapsed: 0 };
  for (const move of f.moves) {
    expect(move.x).toBeGreaterThanOrEqual(previous.x);
    expect(move.y).toBeGreaterThanOrEqual(previous.y);
    expect(move.x).toBeLessThanOrEqual(1010);
    expect(move.y).toBeLessThanOrEqual(520);
    expect(move.elapsed).toBeGreaterThan(previous.elapsed);
    previous = move;
  }
  const middle = Math.floor(f.moves.length / 2);
  expect(f.moves[middle]!.x - f.moves[middle - 1]!.x).toBeGreaterThan(
    f.moves[0]!.x - 10,
  );
  expect(f.moves.at(-1)!.elapsed).toBeLessThanOrEqual(0.401);
});

test("does not animate a pointer already at the click or scroll target", async () => {
  const f = fixture(40, 40);
  await f.act({ action: "click", x: 40, y: 40 });
  await f.act({ action: "scroll", x: 40, y: 40, direction: "down" });
  expect(f.moves).toEqual([]);
  expect(f.clicks).toEqual([
    { x: 40, y: 40 },
    { x: 40, y: 40 },
  ]);
});

test("drags along intermediate positions with the button held and releases at the target", async () => {
  const f = fixture(40, 40);
  await f.act({ action: "drag", x: 40, y: 40, to_x: 240, to_y: 140 });
  expect(f.moves.length).toBeGreaterThan(2);
  expect(f.moves.every((move) => move.down)).toBe(true);
  expect(f.moves.at(-1)).toMatchObject({ x: 240, y: 140 });
  expect(f.isDown()).toBe(false);
});

test.each(["click", "drag"])(
  "cancelling a %s stops motion before the destination and releases input",
  async (action) => {
    const f = fixture(40, 40);
    const abort = new AbortController();
    f.onMove(() => {
      if (f.moves.length === 3) {
        abort.abort();
      }
    });
    const args =
      action === "drag"
        ? { action, x: 40, y: 40, to_x: 1000, to_y: 800 }
        : { action, x: 1000, y: 800 };
    await expect(f.act(args, abort.signal)).rejects.toThrow();
    expect(f.moves).toHaveLength(3);
    expect(f.moves.at(-1)!.x).toBeLessThan(1000);
    expect(f.clicks).toEqual([]);
    expect(f.isDown()).toBe(false);
  },
);

test("small and reverse moves finish at the exact requested coordinates", async () => {
  const f = fixture(41, 40);
  await f.act({ action: "click", x: 40, y: 40 });
  await f.act({ action: "click", x: 0, y: 0 });
  expect(f.clicks).toEqual([
    { x: 40, y: 40 },
    { x: 0, y: 0 },
  ]);
});
