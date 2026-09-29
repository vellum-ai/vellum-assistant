import { expect, test } from "bun:test";
import {
  favoriteModes,
  modeLabel,
  serializeComposerWrite,
} from "./composer-configuration";
const entries = [
  "auto",
  "balanced",
  "quality-optimized",
  "latency-optimized",
  "cost-optimized",
  "custom-1",
  "custom-2",
].map((name) => ({ name }));
test("favorites remove stale duplicates and keep the current mode in five slots", () => {
  const favorites = favoriteModes(
    ["deleted", "custom-1", "custom-1"],
    entries,
    "custom-2",
  );
  expect(favorites.map((entry) => entry.name)).toEqual([
    "auto",
    "balanced",
    "quality-optimized",
    "latency-optimized",
    "custom-2",
  ]);
});

test("choosing a visible mode preserves the button order", () => {
  let ids = favoriteModes([], entries, "balanced").map((entry) => entry.name);
  const initial = [...ids];
  for (const selected of [
    "latency-optimized",
    "cost-optimized",
    "quality-optimized",
    "auto",
    "balanced",
  ]) {
    ids = favoriteModes(ids, entries, selected).map((entry) => entry.name);
    expect(ids).toEqual(initial);
  }
});
test("saved recent-use ordering normalizes before replacing the last visible slot", () => {
  const saved = [
    "cost-optimized",
    "latency-optimized",
    "quality-optimized",
    "balanced",
    "auto",
  ];
  const ids = favoriteModes(saved, entries, "custom-1").map(
    (entry) => entry.name,
  );
  expect(ids).toEqual([
    "auto",
    "balanced",
    "quality-optimized",
    "latency-optimized",
    "custom-1",
  ]);
  expect(
    favoriteModes(ids, entries, "balanced").map((entry) => entry.name),
  ).toEqual(ids);
});

test("custom beta labels are preserved", () => {
  expect(
    modeLabel({ name: "os-beta", source: "managed", label: "My experiment" }),
  ).toBe("My experiment");
  expect(
    modeLabel({ name: "os-beta", source: "managed", label: "OS Beta" }),
  ).toBe("Open Beta");
});
test("writes are ordered, independent between chats, and recover after rejection", async () => {
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = serializeComposerWrite("chat-a", async () => {
    calls.push("first");
    await gate;
    throw new Error("failed");
  });
  const caught = first.catch(() => undefined);
  const second = serializeComposerWrite("chat-a", async () => {
    calls.push("second");
  });
  await serializeComposerWrite("chat-b", async () => {
    calls.push("other");
  });
  expect(calls).toEqual(["first", "other"]);
  release();
  await Promise.all([caught, second]);
  expect(calls).toEqual(["first", "other", "second"]);
});
