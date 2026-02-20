#!/usr/bin/env python3
"""
Record a single guided fixture for identity-resolution testing.

Scenario:
1) background noise only
2) target speaker talks without identifying themselves
3) target speaker states their identity
4) post-identification speech
"""

from __future__ import annotations

import argparse
import json
import pathlib
import time
import wave
from dataclasses import asdict, dataclass

import numpy as np
import sounddevice as sd


@dataclass
class Phase:
    name: str
    start_s: float
    end_s: float
    instruction: str


def save_wav(path: pathlib.Path, data: np.ndarray, sample_rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.clip(data, -32768, 32767).astype(np.int16)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm.tobytes())


def main() -> int:
    parser = argparse.ArgumentParser(description="Record one guided identity-resolution fixture.")
    parser.add_argument("--fixture-id", default=None, help="Optional fixture id; defaults to timestamp")
    parser.add_argument("--expected-name", required=True, help="Name expected to be resolved by end")
    parser.add_argument("--identify-phrase", default=None, help='What you plan to say (e.g. "Hi, I am Aaron")')
    parser.add_argument("--sample-rate", type=int, default=16000)
    parser.add_argument("--device", default=None)
    parser.add_argument("--noise-s", type=float, default=6.0)
    parser.add_argument("--anonymous-s", type=float, default=10.0)
    parser.add_argument("--identify-s", type=float, default=8.0)
    parser.add_argument("--post-s", type=float, default=8.0)
    parser.add_argument("--out-root", default="out/fixtures")
    args = parser.parse_args()

    fixture_id = args.fixture_id or time.strftime("fixture-%Y%m%d-%H%M%S")
    out_root = pathlib.Path(args.out_root)
    chunks_dir = out_root / "chunks"
    truth_dir = out_root / "truth"
    wav_path = chunks_dir / f"{fixture_id}.wav"
    truth_path = truth_dir / f"{fixture_id}.expected.json"

    p1 = Phase(
        name="noise_only",
        start_s=0.0,
        end_s=args.noise_s,
        instruction="Keep ambient room noise only. Do not identify anyone.",
    )
    p2 = Phase(
        name="anonymous_speech",
        start_s=p1.end_s,
        end_s=p1.end_s + args.anonymous_s,
        instruction="Speak normally without saying your name or anyone else's name.",
    )
    p3 = Phase(
        name="self_identification",
        start_s=p2.end_s,
        end_s=p2.end_s + args.identify_s,
        instruction=f'Say your identity clearly (example: "I am {args.expected_name}").',
    )
    p4 = Phase(
        name="post_identification",
        start_s=p3.end_s,
        end_s=p3.end_s + args.post_s,
        instruction="Keep speaking naturally after identification.",
    )
    phases = [p1, p2, p3, p4]
    total_s = p4.end_s

    print("\n[fixture] Guided recording starting.")
    print(f"[fixture] id={fixture_id}")
    print(f"[fixture] total duration ~{total_s:.1f}s")
    for phase in phases:
        print(f"  - {phase.name}: {phase.start_s:.1f}s..{phase.end_s:.1f}s -> {phase.instruction}")
    if args.identify_phrase:
        print(f"[fixture] planned identify phrase: {args.identify_phrase}")

    print("[fixture] recording starts in 3...")
    time.sleep(1)
    print("[fixture] 2...")
    time.sleep(1)
    print("[fixture] 1...")
    time.sleep(1)
    print("[fixture] RECORDING")

    total_samples = int(total_s * args.sample_rate)
    rec = sd.rec(
        total_samples,
        samplerate=args.sample_rate,
        channels=1,
        dtype="int16",
        device=args.device,
    )

    announced = set()
    started = time.monotonic()
    while True:
        elapsed = time.monotonic() - started
        for phase in phases:
            if phase.name not in announced and elapsed >= phase.start_s:
                print(f"[fixture] phase={phase.name}: {phase.instruction}")
                announced.add(phase.name)
        if elapsed >= total_s:
            break
        time.sleep(0.1)

    sd.wait()
    print("[fixture] recording complete")

    save_wav(wav_path, rec.reshape(-1), args.sample_rate)
    truth = {
        "fixture_id": fixture_id,
        "wav_path": str(wav_path),
        "expected_name": args.expected_name,
        "identify_phrase": args.identify_phrase or f"I am {args.expected_name}",
        "expectations": {
            "initially_anonymous": True,
            "should_resolve_name_by_end": True,
            "resolved_name": args.expected_name,
        },
        "phases": [asdict(p) for p in phases],
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    truth_path.parent.mkdir(parents=True, exist_ok=True)
    truth_path.write_text(json.dumps(truth, indent=2), encoding="utf-8")

    print(f"[fixture] wrote wav:   {wav_path}")
    print(f"[fixture] wrote truth: {truth_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
