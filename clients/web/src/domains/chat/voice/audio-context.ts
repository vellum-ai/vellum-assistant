/**
 * Shared `AudioContext` constructor helper for the voice domain.
 *
 * Safari only exposes the prefixed `webkitAudioContext`, so every Web Audio
 * call site needs the `AudioContext ?? webkitAudioContext` fallback. This
 * centralizes that fallback so capture/playback (and any future voice audio
 * code) don't each hand-roll their own copy.
 *
 * Note: `sound-manager.ts` and `use-push-to-talk.ts` predate this helper and
 * still inline the same fallback; they can adopt this in a follow-up.
 */

/** Window augmented with Safari's prefixed AudioContext constructor. */
export type AudioContextWindow = typeof globalThis & {
  webkitAudioContext?: typeof AudioContext;
};

/**
 * Resolve the available `AudioContext` constructor, falling back to Safari's
 * prefixed `webkitAudioContext`. Returns `undefined` when neither exists, so
 * feature-detection sites can branch without constructing a context.
 */
export function getAudioContextCtor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  return window.AudioContext ?? (window as AudioContextWindow).webkitAudioContext;
}

/**
 * Construct an `AudioContext`, falling back to Safari's prefixed
 * `webkitAudioContext`. Throws if neither constructor is available (callers
 * that may run before user gesture / on unsupported platforms should feature
 * detect first).
 */
export function createAudioContext(options?: AudioContextOptions): AudioContext {
  const Ctor = getAudioContextCtor();
  if (!Ctor) {
    throw new Error("Web Audio API is not available in this environment");
  }
  return new Ctor(options);
}
