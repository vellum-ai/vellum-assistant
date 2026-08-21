/**
 * The synthesized "blip": 880 Hz sine, 200 ms, 0.25 peak gain scaled by
 * `volume`. Stand-in for the macOS Tink wherever no sound file plays.
 * Returns the oscillator so callers can hook `onended`.
 */
export function playBlip(ctx: AudioContext, volume = 1): OscillatorNode {
  if (ctx.state === "suspended") {
    void ctx.resume();
  }

  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(880, ctx.currentTime);

  const peak = Math.max(0, Math.min(1, volume)) * 0.25;
  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(peak, ctx.currentTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);

  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start();
  oscillator.stop(ctx.currentTime + 0.2);
  return oscillator;
}
