/**
 * Rolling amplitude history — the shared substrate under every reactive voice
 * visual.
 *
 * The point of the reactive surfaces is that their geometry is a *record* of
 * what was said rather than a shape authored ahead of time, and that record is
 * this: a fixed-size ring buffer of the amplitude, advanced on a wall-clock
 * cadence so the terrain scrolls at the same rate regardless of display
 * refresh. `voice-reactive-waves.tsx` keeps one per layer (differing cadences
 * are what turn one signal into a layered band); `voice-mesh-waves.tsx` keeps a
 * single one shared across all of its depth lines.
 *
 * Deliberately allocation-free after construction: `read` fills a caller-owned
 * array, so a 60 Hz draw loop can run without producing garbage.
 */

/** A fixed-size, time-paced ring buffer of amplitude samples. */
export interface AmplitudeHistory {
  /** Number of samples retained — the horizontal resolution of the terrain. */
  readonly size: number;
  /**
   * Advance by `dtMs`, appending `amp` once per elapsed sample period.
   *
   * A long frame gap (a backgrounded tab, a dropped frame) can span several
   * periods; appending all of them keeps the scroll honest to wall-clock time.
   * The catch-up is capped at one full buffer — past that the whole window is
   * the same value anyway.
   */
  push(amp: number, dtMs: number): void;
  /**
   * Read oldest-first into `out`, applying a centred moving average of width
   * `smooth` samples (1 = raw). `out` must be at least {@link size} long.
   */
  read(out: Float32Array, smooth?: number): void;
}

export function createAmplitudeHistory({
  size,
  periodMs,
}: {
  size: number;
  /** Milliseconds per sample — sets both scroll speed and window length. */
  periodMs: number;
}): AmplitudeHistory {
  const samples = new Float32Array(size);
  // Index of the oldest sample, i.e. the left edge of the rendered terrain.
  let head = 0;
  let elapsed = 0;

  return {
    size,

    push(amp: number, dtMs: number): void {
      elapsed += Math.max(0, dtMs);
      let pushes = Math.floor(elapsed / periodMs);
      if (pushes <= 0) {
        return;
      }
      elapsed -= pushes * periodMs;
      pushes = Math.min(pushes, size);
      for (let i = 0; i < pushes; i++) {
        samples[head] = amp;
        head = (head + 1) % size;
      }
    },

    read(out: Float32Array, smooth = 1): void {
      const half = Math.max(0, Math.floor(smooth / 2));
      for (let i = 0; i < size; i++) {
        if (half === 0) {
          out[i] = samples[(head + i) % size];
          continue;
        }
        let sum = 0;
        let count = 0;
        for (let k = -half; k <= half; k++) {
          const j = i + k;
          if (j < 0 || j >= size) {
            continue;
          }
          sum += samples[(head + j) % size];
          count++;
        }
        out[i] = count > 0 ? sum / count : 0;
      }
    },
  };
}
