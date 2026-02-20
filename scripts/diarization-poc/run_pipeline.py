#!/usr/bin/env python3
"""
Continuous pipeline:
  chunks/*.wav -> OpenAI diarized transcript -> persistent speaker learning

Primary speaker signal is provider diarization (gpt-4o-transcribe-diarize).
Local embeddings are used only to stitch stable identities across chunks.
"""

from __future__ import annotations

import argparse
import os
import pathlib
import time
from typing import Any

from resemblyzer import VoiceEncoder

from transcribe_openai import transcribe_file, extract_segments
from identity_evidence_openai import infer_identity_evidence
from learn_speakers import (
    create_registry,
    load_json,
    process_pair,
    write_json,
)


def fmt_time(seconds: float) -> str:
    whole = max(0, int(seconds))
    m, s = divmod(whole, 60)
    return f"{m:02d}:{s:02d}"


def print_live_segments(rows: list[dict[str, Any]], min_conf: float) -> None:
    for row in rows:
        start = float(row.get("start") or 0.0)
        status = str(row.get("speaker_status") or "anonymous")
        base_label = str(row.get("speaker_display_name") or "Unknown")
        conf = float(row.get("speaker_name_confidence") or 0.0)
        if status != "named" or conf < min_conf:
            # Show anonymous form until model confidence is strong enough.
            gid = str(row.get("speaker_global_id") or "anon")
            base_label = f"Person {gid.replace('anon-', '')}"
        text = str(row.get("text") or "").strip()
        print(f"[{fmt_time(start)}] {base_label} ({status}, conf={conf:.2f}): {text}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run continuous diarization + speaker-learning pipeline.")
    parser.add_argument("--chunks-dir", default="scripts/diarization-poc/out/chunks")
    parser.add_argument("--transcripts-dir", default="scripts/diarization-poc/out/transcripts")
    parser.add_argument("--labeled-dir", default="scripts/diarization-poc/out/labeled")
    parser.add_argument("--state-file", default="scripts/diarization-poc/out/pipeline_state.json")
    parser.add_argument("--registry", default="scripts/diarization-poc/out/speaker_registry.json")
    parser.add_argument("--model", default="gpt-4o-transcribe-diarize")
    parser.add_argument("--poll-interval-s", type=float, default=2.0)
    parser.add_argument("--similarity-threshold", type=float, default=0.72)
    parser.add_argument("--min-segment-s", type=float, default=1.0)
    parser.add_argument("--min-name-score", type=float, default=2.2)
    parser.add_argument("--min-name-margin", type=float, default=0.8)
    parser.add_argument("--min-name-confidence", type=float, default=0.72)
    parser.add_argument("--min-display-name-confidence", type=float, default=0.8)
    parser.add_argument("--identity-model", default="gpt-4o-mini")
    parser.add_argument("--api-key-env", default="OPENAI_API_KEY")
    args = parser.parse_args()

    api_key = os.getenv(args.api_key_env)
    if not api_key:
        raise SystemExit(f"Missing {args.api_key_env}")

    chunks_dir = pathlib.Path(args.chunks_dir)
    transcripts_dir = pathlib.Path(args.transcripts_dir)
    labeled_dir = pathlib.Path(args.labeled_dir)
    state_path = pathlib.Path(args.state_file)
    registry_path = pathlib.Path(args.registry)
    identity_dir = transcripts_dir / "identity-evidence"

    transcripts_dir.mkdir(parents=True, exist_ok=True)
    labeled_dir.mkdir(parents=True, exist_ok=True)
    chunks_dir.mkdir(parents=True, exist_ok=True)
    identity_dir.mkdir(parents=True, exist_ok=True)

    state = load_json(state_path, {"processed": []})
    processed: set[str] = set(state.get("processed", []))
    registry = load_json(registry_path, create_registry())
    encoder = VoiceEncoder()

    print(
        f"[pipeline] watching={chunks_dir} model={args.model} "
        f"similarity_threshold={args.similarity_threshold}"
    )

    while True:
        wavs = sorted(chunks_dir.glob("*.wav"))
        for wav in wavs:
            if wav.name in processed:
                continue

            try:
                raw = transcribe_file(
                    wav_path=wav,
                    api_key=api_key,
                    model=args.model,
                    language=None,
                    temperature=None,
                )
            except Exception as exc:
                print(f"[pipeline] transcribe failed {wav.name}: {exc}")
                continue

            raw_path = transcripts_dir / f"{wav.stem}.json"
            segments_path = transcripts_dir / f"{wav.stem}.segments.json"
            write_json(raw_path, raw)
            segments = extract_segments(raw)
            write_json(segments_path, {"segments": segments})

            identity = infer_identity_evidence(
                segments=segments,
                api_key=api_key,
                model=args.identity_model,
            )
            identity_path = identity_dir / f"{wav.stem}.identity.json"
            write_json(identity_path, identity)

            labeled = process_pair(
                wav,
                segments_path,
                registry=registry,
                encoder=encoder,
                similarity_threshold=args.similarity_threshold,
                min_segment_s=args.min_segment_s,
                identity_evidence=identity.get("evidence"),
                min_name_score=args.min_name_score,
                min_name_margin=args.min_name_margin,
                min_name_confidence=args.min_name_confidence,
            )
            labeled_path = labeled_dir / f"{wav.stem}.labeled.json"
            write_json(
                labeled_path,
                {
                    "source_wav": str(wav),
                    "source_transcript": str(segments_path),
                    "source_identity_evidence": str(identity_path),
                    "segments": labeled,
                },
            )

            processed.add(wav.name)
            state["processed"] = sorted(processed)
            write_json(state_path, state)
            write_json(registry_path, registry)
            print(f"[pipeline] processed {wav.name} -> {labeled_path.name}")
            print_live_segments(labeled, min_conf=args.min_display_name_confidence)

        time.sleep(args.poll_interval_s)


if __name__ == "__main__":
    raise SystemExit(main())
