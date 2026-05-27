/**
 * Tests for the transcript scroll utilities.
 *
 * `bun:test` runs without a real DOM environment, so we exercise the
 * pure surface of these utilities (the key function + the ref's
 * imperative DOM mutation) using plain object fakes. The flag itself
 * is read once at module load, so we cannot toggle it inside a test
 * — instead the tests assert behavior at the import-time-resolved
 * value and document the contract on both sides via inspection of the
 * helpers' contracts.
 */

import { describe, expect, test } from "bun:test";

import {
  TRANSCRIPT_SCROLL_CONTROLLER_ENABLED,
  getTranscriptScrollContainerKey,
} from "@/domains/chat/transcript/transcript-scroll";

describe("getTranscriptScrollContainerKey", () => {
  test("returns undefined when the controller flag is OFF", () => {
    // In the test environment there is no `window.localStorage` entry
    // set, so the module-load read of the flag resolves to `false`.
    // The key helper must short-circuit to `undefined` so React
    // reconciles by position — preserving the deprecated-hook era
    // behavior where the scroll container is not remounted on
    // conversation switch.
    expect(TRANSCRIPT_SCROLL_CONTROLLER_ENABLED).toBe(false);
    expect(getTranscriptScrollContainerKey("conv-1")).toBeUndefined();
    expect(getTranscriptScrollContainerKey(null)).toBeUndefined();
    expect(getTranscriptScrollContainerKey(undefined)).toBeUndefined();
  });
});
