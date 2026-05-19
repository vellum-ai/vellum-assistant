import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

interface AudioSpectrumProps {
  /** Mic amplitude 0..1; drives the live bin distribution. */
  readonly amplitude: number;
  /** Number of vertical bars rendered. */
  readonly bins?: number;
  /** When false, bars decay toward zero (idle ambient state). */
  readonly active?: boolean;
}

/**
 * Pseudo-FFT spectrum bar chart driven by mic amplitude. We don't have
 * raw frequency data on the JS side (mic frames are int16 PCM), so we
 * synthesise plausible bin energies via stable per-bin oscillators
 * modulated by the current RMS amplitude. The result reads as a live
 * spectrogram without the cost of an actual FFT.
 */
export function AudioSpectrum({
  amplitude,
  bins = 28,
  active = true,
}: AudioSpectrumProps): JSX.Element {
  const phases = useMemo(
    () =>
      Array.from({ length: bins }, (_, i) => ({
        base: 0.18 + Math.sin((i / bins) * Math.PI) * 0.55,
        speed: 0.6 + (i % 5) * 0.15,
        offset: (i * 7919) % 360,
      })),
    [bins],
  );

  const [t, setT] = useState(0);
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    let mounted = true;
    const tick = (now: number) => {
      if (!mounted) return;
      setT(now / 1000);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      mounted = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const energy = active ? Math.max(amplitude, 0.04) : 0.02;

  return (
    <div className="spectrum" aria-hidden>
      {phases.map((p, idx) => {
        const wave = Math.sin(t * p.speed + p.offset) * 0.5 + 0.5;
        const h = Math.min(1, p.base * wave * (0.4 + energy * 1.8));
        return (
          <span
            key={idx}
            className="spectrum-bar"
            style={{ height: `${Math.max(2, h * 100)}%` }}
          />
        );
      })}
    </div>
  );
}
