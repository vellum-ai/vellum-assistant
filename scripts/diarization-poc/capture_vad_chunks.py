#!/usr/bin/env python3
"""
Capture microphone audio and flush WAV chunks when speech stops.

This is intentionally independent from the app runtime so you can evaluate
chunking quality in isolation for a diarization PoC.
"""

from __future__ import annotations

import argparse
import collections
import pathlib
import queue
import signal
import sys
import time
import wave

import numpy as np
import sounddevice as sd

try:
    import webrtcvad  # type: ignore
    HAVE_WEBRTCVAD = True
except Exception:
    webrtcvad = None
    HAVE_WEBRTCVAD = False


class EnergyVad:
    """
    Minimal fallback VAD when webrtcvad is unavailable.

    Uses frame RMS against a calibrated noise floor and a mode-dependent
    multiplier so existing --vad-mode still affects aggressiveness.
    """

    def __init__(self, mode: int) -> None:
        self.mode = mode
        self.noise_floor = 200.0
        self.frames_seen = 0
        self.mode_multipliers = {0: 1.2, 1: 1.6, 2: 2.0, 3: 2.5}

    def is_speech(self, frame: bytes, _sample_rate: int) -> bool:
        samples = np.frombuffer(frame, dtype=np.int16).astype(np.float32)
        if samples.size == 0:
            return False
        rms = float(np.sqrt(np.mean(samples * samples)))
        if self.frames_seen < 80:
            self.noise_floor = 0.95 * self.noise_floor + 0.05 * rms
        else:
            if rms < self.noise_floor * 1.5:
                self.noise_floor = 0.995 * self.noise_floor + 0.005 * rms
        self.frames_seen += 1
        threshold = max(300.0, self.noise_floor * self.mode_multipliers.get(self.mode, 2.0))
        return rms >= threshold


def save_wav(path: pathlib.Path, pcm_bytes: bytes, sample_rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit PCM
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_bytes)


def main() -> int:
    parser = argparse.ArgumentParser(description="Capture speech chunks from microphone using VAD.")
    parser.add_argument("--out-dir", default="scripts/diarization-poc/out/chunks")
    parser.add_argument("--sample-rate", type=int, default=16000)
    parser.add_argument("--frame-ms", type=int, default=30, choices=[10, 20, 30])
    parser.add_argument("--vad-mode", type=int, default=2, choices=[0, 1, 2, 3])
    parser.add_argument("--pre-roll-ms", type=int, default=300)
    parser.add_argument("--silence-ms", type=int, default=2500)
    parser.add_argument("--min-chunk-ms", type=int, default=900)
    parser.add_argument("--max-chunk-ms", type=int, default=60000)
    parser.add_argument("--device", default=None, help="Optional sounddevice input device id/name")
    args = parser.parse_args()

    out_dir = pathlib.Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    frame_samples = int(args.sample_rate * args.frame_ms / 1000)
    frame_bytes = frame_samples * 2
    pre_roll_frames = max(1, int(args.pre_roll_ms / args.frame_ms))
    silence_frames_limit = max(1, int(args.silence_ms / args.frame_ms))
    min_chunk_frames = max(1, int(args.min_chunk_ms / args.frame_ms))
    max_chunk_frames = max(1, int(args.max_chunk_ms / args.frame_ms))

    vad = webrtcvad.Vad(args.vad_mode) if HAVE_WEBRTCVAD else EnergyVad(args.vad_mode)
    q: queue.Queue[bytes] = queue.Queue()
    stop = False

    def on_signal(_sig: int, _frame: object) -> None:
        nonlocal stop
        stop = True

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)

    def callback(indata: bytes, frames: int, _time: object, status: sd.CallbackFlags) -> None:
        if status:
            print(f"[capture] status: {status}", file=sys.stderr)
        if frames <= 0:
            return
        q.put(bytes(indata))

    backend = "webrtcvad" if HAVE_WEBRTCVAD else "energy-vad-fallback"
    print(
        f"[capture] listening device={args.device!r} sample_rate={args.sample_rate} frame_ms={args.frame_ms} "
        f"silence_ms={args.silence_ms} vad={backend} out={out_dir}"
    )

    pre_roll: collections.deque[bytes] = collections.deque(maxlen=pre_roll_frames)
    active_frames: list[bytes] = []
    in_speech = False
    silence_run = 0
    chunk_index = 1

    with sd.RawInputStream(
        samplerate=args.sample_rate,
        blocksize=frame_samples,
        dtype="int16",
        channels=1,
        callback=callback,
        device=args.device,
    ):
        while not stop:
            try:
                frame = q.get(timeout=0.5)
            except queue.Empty:
                continue

            if len(frame) != frame_bytes:
                continue

            speech = vad.is_speech(frame, args.sample_rate)
            pre_roll.append(frame)

            if not in_speech:
                if speech:
                    in_speech = True
                    silence_run = 0
                    active_frames = list(pre_roll)
                continue

            active_frames.append(frame)
            if speech:
                silence_run = 0
            else:
                silence_run += 1

            should_flush = False
            if silence_run >= silence_frames_limit and len(active_frames) >= min_chunk_frames:
                should_flush = True
            if len(active_frames) >= max_chunk_frames:
                should_flush = True

            if should_flush:
                pcm = b"".join(active_frames)
                ts = time.strftime("%Y%m%d-%H%M%S")
                out_path = out_dir / f"chunk-{ts}-{chunk_index:04d}.wav"
                chunk_index += 1
                save_wav(out_path, pcm, args.sample_rate)
                duration_s = len(active_frames) * args.frame_ms / 1000.0
                print(f"[capture] wrote {out_path} ({duration_s:.2f}s)")

                # Reset for next chunk.
                in_speech = False
                silence_run = 0
                active_frames = []

    print("[capture] stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
