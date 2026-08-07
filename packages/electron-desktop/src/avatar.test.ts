import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { z } from "zod";

// Capture the channel + schema + handler that `installAvatarIpc` registers,
// without dragging in the real `ipcMain` / sender-origin guard (covered by
// `ipc.test.ts`). The captured schema is exercised directly to assert the
// payload contract the renderer must satisfy.
type OnRegistration = {
  channel: string;
  schema: z.ZodType<unknown[]>;
  fn: (args: unknown[]) => void;
};
const registrations: OnRegistration[] = [];
const onMock = mock(
  (
    channel: string,
    schema: z.ZodType<unknown[]>,
    fn: (args: unknown[]) => void,
  ) => {
    registrations.push({ channel, schema, fn });
  },
);
mock.module("./presence-runtime", () => ({ on: onMock }));

const {
  getAvatarPng,
  onAvatarChange,
  setAvatar,
  installAvatarIpc,
  __resetForTesting,
} = await import("./avatar");

beforeEach(() => {
  __resetForTesting();
  registrations.length = 0;
  onMock.mockClear();
});

describe("avatar cache", () => {
  test("starts empty and reports null", () => {
    expect(getAvatarPng()).toBeNull();
  });

  test("caches a published PNG and clears on null", () => {
    const png = Buffer.from([1, 2, 3]);
    setAvatar(png);
    expect(getAvatarPng()).toBe(png);
    setAvatar(null);
    expect(getAvatarPng()).toBeNull();
  });

  test("notifies subscribers on every publish, including transitions to null", () => {
    const seen: (number | null)[] = [];
    onAvatarChange(() => seen.push(getAvatarPng()?.length ?? null));

    setAvatar(Buffer.from([1, 2]));
    setAvatar(Buffer.from([1, 2, 3]));
    setAvatar(null);

    expect(seen).toEqual([2, 3, null]);
  });

  test("unsubscribe stops further notifications", () => {
    let count = 0;
    const unsubscribe = onAvatarChange(() => count++);
    setAvatar(Buffer.from([1]));
    unsubscribe();
    setAvatar(null);
    expect(count).toBe(1);
  });
});

describe("installAvatarIpc", () => {
  test("registers both channels once, even across repeated calls", () => {
    installAvatarIpc();
    installAvatarIpc();
    expect(registrations.map((r) => r.channel)).toEqual([
      "vellum:icon:setAvatar",
      "vellum:icon:setCharacter",
    ]);
  });

  test("the character schema takes the three trait ids, or null", () => {
    installAvatarIpc();
    const schema = registrations[1]!.schema;
    expect(
      schema.safeParse([
        { bodyShape: "burst", eyeStyle: "curious", color: "teal" },
      ]).success,
    ).toBe(true);
    expect(schema.safeParse([null]).success).toBe(true);
    // A partial character would compose into nothing, so it is refused at the
    // boundary rather than halfway through a render.
    expect(schema.safeParse([{ bodyShape: "burst" }]).success).toBe(false);
    expect(schema.safeParse(["burst"]).success).toBe(false);
  });

  test("the schema accepts a Uint8Array or null and rejects anything else", () => {
    installAvatarIpc();
    const schema = registrations[0]!.schema;
    expect(schema.safeParse([new Uint8Array([1, 2, 3])]).success).toBe(true);
    expect(schema.safeParse([null]).success).toBe(true);
    expect(schema.safeParse(["nope"]).success).toBe(false);
    expect(schema.safeParse([]).success).toBe(false);
    expect(schema.safeParse([new Uint8Array(), new Uint8Array()]).success).toBe(
      false,
    );
  });

  test("a Uint8Array payload is normalized to a Buffer and cached", () => {
    installAvatarIpc();
    const seen: number[] = [];
    onAvatarChange(() => seen.push(getAvatarPng()?.length ?? -1));

    registrations[0]!.fn([new Uint8Array([9, 8, 7, 6])]);
    const cached = getAvatarPng();
    expect(Buffer.isBuffer(cached)).toBe(true);
    expect([...cached!]).toEqual([9, 8, 7, 6]);
    expect(seen).toEqual([4]);
  });

  test("a null payload clears the cache", () => {
    installAvatarIpc();
    setAvatar(Buffer.from([1, 2, 3]));
    registrations[0]!.fn([null]);
    expect(getAvatarPng()).toBeNull();
  });
});
