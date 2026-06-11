
import { useEffect, useRef, useState } from "react";

import { getVoiceInputMediaStream } from "@/utils/voice-input-device";

/**
 * Real-time microphone amplitude via Web Audio API.
 *
 * When `active` is true, pipes audio through an `AnalyserNode` and reads RMS
 * amplitude at ~33 Hz (every `requestAnimationFrame`). The raw RMS is
 * exponentially smoothed (0.5/0.5 EMA) and scaled to 0-1 via
 * `min(smoothed * 14.0, 1.0)`, matching the macOS
 * `AudioEngineController` algorithm.
 *
 * When `stream` is provided the hook reuses it for analysis and does NOT stop
 * its tracks on cleanup — the caller owns the stream lifecycle. When `stream`
 * is omitted the hook opens its own `getUserMedia` stream and stops it on
 * cleanup (original behaviour).
 *
 * Returns `amplitude` in the range [0, 1]. Returns 0 when inactive.
 */
export function useAudioAmplitude({
  active,
  stream: externalStream,
}: {
  active: boolean;
  /** Optional externally-owned MediaStream to reuse for analysis. */
  stream?: MediaStream | null;
}): {
  amplitude: number;
} {
  const [amplitude, setAmplitude] = useState(0);

  const audioContextRef = useRef<AudioContext | null>(null);
  const ownStreamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const smoothedRef = useRef(0);
  const lastSetRef = useRef(0);

  useEffect(() => {
    if (!active) {
      smoothedRef.current = 0;
      return;
    }

    let cancelled = false;

    function attachStream(stream: MediaStream) {
      if (cancelled) return;
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.fftSize);

      function tick() {
        if (cancelled) return;

        analyser.getByteTimeDomainData(dataArray);

        let sumSquares = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const normalized = (dataArray[i]! - 128) / 128;
          sumSquares += normalized * normalized;
        }
        const rawRMS = Math.sqrt(sumSquares / dataArray.length);

        const smoothed = 0.5 * rawRMS + 0.5 * smoothedRef.current;
        smoothedRef.current = smoothed;

        const scaled = Math.min(smoothed * 14.0, 1.0);
        if (scaled !== lastSetRef.current) {
          lastSetRef.current = scaled;
          setAmplitude(scaled);
        }

        rafRef.current = requestAnimationFrame(tick);
      }

      rafRef.current = requestAnimationFrame(tick);
    }

    if (externalStream) {
      // Reuse the caller-owned stream — don't stop its tracks on cleanup.
      attachStream(externalStream);
    } else {
      // Open our own stream; we own its lifecycle.
      getVoiceInputMediaStream()
        .then((stream) => {
          if (cancelled) {
            for (const track of stream.getTracks()) {
              track.stop();
            }
            return;
          }
          ownStreamRef.current = stream;
          attachStream(stream);
        })
        .catch(() => {
          if (ownStreamRef.current) {
            for (const track of ownStreamRef.current.getTracks()) {
              track.stop();
            }
            ownStreamRef.current = null;
          }
          setAmplitude(0);
        });
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;

      // Only stop tracks if we own the stream.
      if (ownStreamRef.current) {
        for (const track of ownStreamRef.current.getTracks()) {
          track.stop();
        }
        ownStreamRef.current = null;
      }

      if (audioContextRef.current) {
        void audioContextRef.current.close();
        audioContextRef.current = null;
      }

      smoothedRef.current = 0;
    };
  }, [active, externalStream]);

  // Derive 0 when inactive rather than calling setState synchronously in the
  // effect body (react-hooks/set-state-in-effect). This also resets the
  // waveform instantly when recording stops, before the next rAF tick fires.
  return { amplitude: active ? amplitude : 0 };
}
