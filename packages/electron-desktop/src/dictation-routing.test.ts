import { expect, test } from "bun:test";
import type { WebContents } from "electron";

import { DictationOwnerRouter, toAudioBuffer } from "./dictation-routing";

const fakeWebContents = (destroyed = false): WebContents =>
  ({ isDestroyed: () => destroyed }) as unknown as WebContents;

test("audio conversion accepts every structured-clone PCM shape", () => {
  /** The renderer's worklet frames arrive as Buffer, Uint8Array or ArrayBuffer. */
  // GIVEN the same two bytes carried by each transport shape
  const bytes = [1, 2];
  // WHEN each shape is normalized
  // THEN all yield an equal Buffer, and unrelated payloads are rejected
  expect(toAudioBuffer(Buffer.from(bytes))).toEqual(Buffer.from(bytes));
  expect(toAudioBuffer(new Uint8Array(bytes))).toEqual(Buffer.from(bytes));
  expect(toAudioBuffer(new Uint8Array(bytes).buffer)).toEqual(
    Buffer.from(bytes),
  );
  expect(toAudioBuffer("pcm")).toBeNull();
});

test("only the window that enabled partials may push audio", () => {
  /** Audio push is scoped to the recording window to keep sessions isolated. */
  // GIVEN a window that enabled partials
  const router = new DictationOwnerRouter();
  const recording = fakeWebContents();
  const other = fakeWebContents();
  router.setOwner(recording, true);

  // WHEN another window pushes audio
  // THEN only the recording window is accepted
  expect(router.ownsPartials(recording)).toBe(true);
  expect(router.ownsPartials(other)).toBe(false);
});

test("post-session events still reach the window that stopped recording", () => {
  /** The finalized transcript arrives after partials are disabled. */
  // GIVEN a window that enabled and then disabled partials
  const router = new DictationOwnerRouter();
  const recording = fakeWebContents();
  router.setOwner(recording, true);
  router.setOwner(recording, false);

  // WHEN the helper emits the finalized transcript
  // THEN the window remains addressable but can no longer push audio
  expect(router.target()).toBe(recording);
  expect(router.ownsPartials(recording)).toBe(false);
});

test("destroyed and cleared owners drop events instead of throwing", () => {
  /** Helper restarts and closed windows must not surface dead senders. */
  // GIVEN a destroyed owner
  const router = new DictationOwnerRouter();
  router.setOwner(fakeWebContents(true), true);

  // WHEN routing an event, and then after the session is cleared
  // THEN no target is returned in either case
  expect(router.target()).toBeNull();
  router.setOwner(fakeWebContents(), true);
  router.clear();
  expect(router.target()).toBeNull();
});
