#!/usr/bin/env python3
"""
Single-command live pipeline:
  mic capture -> chunk WAV -> OpenAI diarized transcript -> identity evidence -> speaker learning

By default this script launches local capture internally, so you only need one terminal.
"""

from __future__ import annotations

import atexit
import argparse
import os
import pathlib
import re
import signal
import subprocess
import sys
import time
from typing import Any

from dotenv import load_dotenv
from identity_evidence_openai import infer_identity_evidence
from learn_speakers import (
    create_registry,
    create_voice_encoder,
    load_json,
    process_pair,
    write_json,
)
from transcribe_openai import extract_segments, transcribe_file


def fmt_time(seconds: float) -> str:
    whole = max(0, int(seconds))
    m, s = divmod(whole, 60)
    return f"{m:02d}:{s:02d}"


def print_live_segments(rows: list[dict[str, Any]], min_conf: float) -> None:
    for row in rows:
        start = float(row.get("start") or 0.0)
        text = str(row.get("text") or "").strip()
        if not text:
            continue
        status = str(row.get("speaker_status") or "anonymous")
        base_label = str(row.get("speaker_display_name") or "Unknown")
        conf = float(row.get("speaker_name_confidence") or 0.0)
        if status != "named" or conf < min_conf:
            gid = str(row.get("speaker_global_id") or "").strip()
            if gid.startswith("anon-"):
                base_label = f"Person {gid.replace('anon-', '')}"
            else:
                local = str(row.get("speaker_local") or "").strip()
                base_label = f"Speaker {local}" if local else "Speaker"
        print(f"[{fmt_time(start)}] {base_label} ({status}, conf={conf:.2f}): {text}")


def extract_http_status(err: Exception) -> int | None:
    m = re.search(r"transcription failed\\s+(\\d{3})", str(err))
    if not m:
        return None
    try:
        return int(m.group(1))
    except ValueError:
        return None


def build_capture_command(args: argparse.Namespace, chunks_dir: pathlib.Path) -> list[str]:
    script = pathlib.Path(__file__).with_name("capture_vad_chunks.py")
    cmd = [
        sys.executable,
        str(script),
        "--out-dir",
        str(chunks_dir),
        "--sample-rate",
        str(args.capture_sample_rate),
        "--frame-ms",
        str(args.capture_frame_ms),
        "--vad-mode",
        str(args.capture_vad_mode),
        "--pre-roll-ms",
        str(args.capture_pre_roll_ms),
        "--silence-ms",
        str(args.capture_silence_ms),
        "--min-chunk-ms",
        str(args.capture_min_chunk_ms),
        "--max-chunk-ms",
        str(args.capture_max_chunk_ms),
    ]
    if args.capture_device:
        cmd.extend(["--device", str(args.capture_device)])
    return cmd


def main() -> int:
    script_dir = pathlib.Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(
        description="Run continuous diarization + speaker-learning pipeline in one process."
    )
    parser.add_argument("--chunks-dir", default=str(script_dir / "out/chunks"))
    parser.add_argument("--transcripts-dir", default=str(script_dir / "out/transcripts"))
    parser.add_argument("--labeled-dir", default=str(script_dir / "out/labeled"))
    parser.add_argument("--state-file", default=str(script_dir / "out/pipeline_state.json"))
    parser.add_argument("--registry", default=str(script_dir / "out/speaker_registry.json"))
    parser.add_argument("--model", default="gpt-4o-transcribe-diarize")
    parser.add_argument("--identity-model", default="gpt-4o-mini")
    parser.add_argument("--poll-interval-s", type=float, default=2.0)
    parser.add_argument("--similarity-threshold", type=float, default=0.72)
    parser.add_argument("--min-segment-s", type=float, default=0.6)
    parser.add_argument("--min-name-score", type=float, default=2.2)
    parser.add_argument("--min-name-margin", type=float, default=0.8)
    parser.add_argument("--min-name-confidence", type=float, default=0.72)
    parser.add_argument("--min-display-name-confidence", type=float, default=0.8)
    parser.add_argument("--no-resemblyzer", action="store_true")
    parser.add_argument("--capture", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--capture-sample-rate", type=int, default=16000)
    parser.add_argument("--capture-frame-ms", type=int, default=30, choices=[10, 20, 30])
    parser.add_argument("--capture-vad-mode", type=int, default=2, choices=[0, 1, 2, 3])
    parser.add_argument("--capture-pre-roll-ms", type=int, default=300)
    parser.add_argument("--capture-silence-ms", type=int, default=2500)
    parser.add_argument("--capture-min-chunk-ms", type=int, default=900)
    parser.add_argument("--capture-max-chunk-ms", type=int, default=60000)
    parser.add_argument("--capture-device", default=None)
    parser.add_argument("--max-transcribe-retries-per-chunk", type=int, default=6)
    parser.add_argument("--max-failure-backoff-s", type=float, default=120.0)
    parser.add_argument("--api-key-env", default="OPENAI_API_KEY")
    args = parser.parse_args()

    load_dotenv(script_dir / ".env", override=False)
    load_dotenv(override=False)

    api_key = os.getenv(args.api_key_env)
    if not api_key:
        raise SystemExit(f"Missing {args.api_key_env}")

    chunks_dir = pathlib.Path(args.chunks_dir)
    transcripts_dir = pathlib.Path(args.transcripts_dir)
    labeled_dir = pathlib.Path(args.labeled_dir)
    state_path = pathlib.Path(args.state_file)
    registry_path = pathlib.Path(args.registry)
    identity_dir = transcripts_dir / "identity-evidence"

    chunks_dir.mkdir(parents=True, exist_ok=True)
    transcripts_dir.mkdir(parents=True, exist_ok=True)
    labeled_dir.mkdir(parents=True, exist_ok=True)
    identity_dir.mkdir(parents=True, exist_ok=True)

    state = load_json(state_path, {"processed": [], "failed": {}, "permanent_failed": []})
    processed: set[str] = set(state.get("processed", []))
    failed: dict[str, dict[str, Any]] = dict(state.get("failed", {}))
    permanent_failed: set[str] = set(state.get("permanent_failed", []))
    registry = load_json(registry_path, create_registry())
    encoder, encoder_backend = create_voice_encoder(prefer_resemblyzer=not args.no_resemblyzer)

    stop = False
    capture_proc: subprocess.Popen[Any] | None = None

    def shutdown_capture() -> None:
        nonlocal capture_proc
        if capture_proc and capture_proc.poll() is None:
            capture_proc.terminate()
            try:
                capture_proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                capture_proc.kill()
        capture_proc = None

    def on_sigterm(_sig: int, _frame: object) -> None:
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, on_sigterm)
    atexit.register(shutdown_capture)

    print(
        f"[pipeline] watching={chunks_dir} model={args.model} "
        f"similarity_threshold={args.similarity_threshold} encoder={encoder_backend}"
    )

    if args.capture:
        capture_cmd = build_capture_command(args, chunks_dir)
        capture_proc = subprocess.Popen(capture_cmd)
        print(f"[pipeline] started capture pid={capture_proc.pid}")
    else:
        print("[pipeline] capture disabled (--no-capture); expecting WAV files in chunks dir")

    try:
        while not stop:
            if capture_proc and capture_proc.poll() is not None:
                print(f"[pipeline] capture exited with code={capture_proc.returncode}")
                stop = True
                break

            wavs = sorted(chunks_dir.glob("*.wav"))
            for wav in wavs:
                if stop:
                    break
                if wav.name in processed:
                    continue
                if wav.name in permanent_failed:
                    continue

                failure_entry = failed.get(wav.name) or {}
                next_retry_at = float(failure_entry.get("next_retry_at", 0.0) or 0.0)
                if next_retry_at > time.time():
                    continue

                print(f"[pipeline] processing {wav.name}")
                try:
                    raw = transcribe_file(
                        wav_path=wav,
                        api_key=api_key,
                        model=args.model,
                        language=None,
                        temperature=None,
                    )
                except Exception as exc:
                    now = time.time()
                    status = extract_http_status(exc)
                    attempts = int(failure_entry.get("attempts", 0)) + 1
                    backoff_s = min(args.max_failure_backoff_s, float(2 ** min(attempts, 7)))
                    failed[wav.name] = {
                        "attempts": attempts,
                        "last_error": str(exc),
                        "last_status": status,
                        "next_retry_at": now + backoff_s,
                        "last_failed_at": now,
                    }
                    state["failed"] = failed
                    write_json(state_path, state)

                    if status is not None and 400 <= status < 500 and attempts >= args.max_transcribe_retries_per_chunk:
                        permanent_failed.add(wav.name)
                        processed.add(wav.name)
                        state["permanent_failed"] = sorted(permanent_failed)
                        state["processed"] = sorted(processed)
                        write_json(state_path, state)
                        print(
                            f"[pipeline] transcribe permanently failed {wav.name} after {attempts} attempts "
                            f"(status={status}). Skipping this chunk."
                        )
                    else:
                        print(
                            f"[pipeline] transcribe failed {wav.name} (attempt {attempts}, "
                            f"retry in {backoff_s:.0f}s): {exc}"
                        )
                    continue

                if wav.name in failed:
                    del failed[wav.name]
                    state["failed"] = failed
                    write_json(state_path, state)

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
                state["failed"] = failed
                state["permanent_failed"] = sorted(permanent_failed)
                write_json(state_path, state)
                write_json(registry_path, registry)
                print(f"[pipeline] processed {wav.name} -> {labeled_path.name}")
                print_live_segments(labeled, min_conf=args.min_display_name_confidence)

            if not stop:
                time.sleep(args.poll_interval_s)
    except KeyboardInterrupt:
        print("[pipeline] interrupt received, shutting down...")
    finally:
        shutdown_capture()
        print("[pipeline] stopped")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
