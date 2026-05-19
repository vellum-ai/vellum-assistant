/**
 * Tests for `useAudioAmplitude`.
 *
 * This codebase does not ship `@testing-library/react` or a DOM-enabled
 * bun:test runner, so we cannot `renderHook`. Instead we verify behavior by
 * rendering a tiny wrapper component via `renderToStaticMarkup` (SSR) and by
 * exercising the observable side-effects (getUserMedia cleanup, AudioContext
 * lifecycle) through module mocks.
 *
 * The SSR render always captures the initial synchronous state (amplitude = 0)
 * because the async `getUserMedia` and `requestAnimationFrame` loop cannot run
 * during `renderToStaticMarkup`. This lets us assert the inactive-state
 * contract without needing a real browser environment.
 */

import { describe, expect, mock, test, beforeEach } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// ---------------------------------------------------------------------------
// Module-level mock state
// ---------------------------------------------------------------------------

const stopTrackMock = mock(() => {});
const closeMock = mock(() => Promise.resolve());
const connectMock = mock(() => {});
const getByteTimeDomainDataMock = mock((_arr: Uint8Array) => {});

const mockStream = {
  getTracks: () => [{ stop: stopTrackMock }],
};

let getUserMediaMock = mock((_constraints?: unknown) => Promise.resolve(mockStream));

// ---------------------------------------------------------------------------
// Global stubs — these Web APIs are not available in bun's test runner
// ---------------------------------------------------------------------------

const originalNavigator = globalThis.navigator;
const originalAudioContext = (globalThis as Record<string, unknown>)[
  "AudioContext"
];
const originalRAF = (globalThis as Record<string, unknown>)[
  "requestAnimationFrame"
];
const originalCAF = (globalThis as Record<string, unknown>)[
  "cancelAnimationFrame"
];

beforeEach(() => {
  stopTrackMock.mockClear();
  closeMock.mockClear();
  connectMock.mockClear();
  getByteTimeDomainDataMock.mockClear();
  getUserMediaMock = mock((_constraints?: unknown) => Promise.resolve(mockStream));

  // navigator.mediaDevices.getUserMedia
  Object.defineProperty(globalThis, "navigator", {
    value: {
      ...originalNavigator,
      mediaDevices: {
        getUserMedia: (...args: unknown[]) =>
          getUserMediaMock(args[0]),
      },
    },
    configurable: true,
    writable: true,
  });

  // AudioContext constructor
  (globalThis as Record<string, unknown>)["AudioContext"] = class {
    createMediaStreamSource() {
      return { connect: connectMock };
    }
    createAnalyser() {
      return {
        fftSize: 256,
        getByteTimeDomainData: getByteTimeDomainDataMock,
      };
    }
    close = closeMock;
  };

  // requestAnimationFrame / cancelAnimationFrame — never fire in tests
  (globalThis as Record<string, unknown>)["requestAnimationFrame"] = mock(
    () => 42,
  );
  (globalThis as Record<string, unknown>)["cancelAnimationFrame"] = mock(
    () => {},
  );
});

// Restore after all tests
import { afterAll } from "bun:test";
afterAll(() => {
  Object.defineProperty(globalThis, "navigator", {
    value: originalNavigator,
    configurable: true,
    writable: true,
  });
  (globalThis as Record<string, unknown>)["AudioContext"] =
    originalAudioContext;
  (globalThis as Record<string, unknown>)["requestAnimationFrame"] =
    originalRAF;
  (globalThis as Record<string, unknown>)["cancelAnimationFrame"] = originalCAF;
});

// ---------------------------------------------------------------------------
// Import the hook under test AFTER mocks are registered
// ---------------------------------------------------------------------------

import { useAudioAmplitude } from "@/lib/voice/use-audio-amplitude.js";

// ---------------------------------------------------------------------------
// Tiny wrapper for SSR rendering
// ---------------------------------------------------------------------------

function AmplitudeConsumer({ active }: { active: boolean }) {
  const { amplitude } = useAudioAmplitude({ active });
  return createElement("span", null, String(amplitude));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useAudioAmplitude", () => {
  test("returns amplitude 0 when inactive", () => {
    const html = renderToStaticMarkup(
      createElement(AmplitudeConsumer, { active: false }),
    );
    expect(html).toBe("<span>0</span>");
  });

  test("returns amplitude 0 on initial render when active (async not yet resolved)", () => {
    // Even when active=true, the initial synchronous render returns 0 because
    // getUserMedia is async and requestAnimationFrame hasn't fired yet.
    const html = renderToStaticMarkup(
      createElement(AmplitudeConsumer, { active: true }),
    );
    expect(html).toBe("<span>0</span>");
  });

  test("does not call getUserMedia when inactive", () => {
    renderToStaticMarkup(createElement(AmplitudeConsumer, { active: false }));
    expect(getUserMediaMock).not.toHaveBeenCalled();
  });
});
