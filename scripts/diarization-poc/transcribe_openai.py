#!/usr/bin/env python3
"""
Send local WAV chunks to OpenAI transcription endpoint and persist raw output.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import time
from typing import Any

from dotenv import load_dotenv
import requests


def collect_wavs(path_value: str) -> list[pathlib.Path]:
    path = pathlib.Path(path_value)
    if path.is_file() and path.suffix.lower() == ".wav":
        return [path]
    if path.is_dir():
        return sorted(path.glob("*.wav"))
    return sorted(pathlib.Path().glob(path_value))


def transcribe_file(
    wav_path: pathlib.Path,
    api_key: str,
    model: str,
    language: str | None,
    temperature: float | None,
) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {api_key}"}
    data: dict[str, str] = {
        "model": model,
        "response_format": "verbose_json",
    }
    if language:
        data["language"] = language
    if temperature is not None:
        data["temperature"] = str(temperature)

    with wav_path.open("rb") as f:
        files = {"file": (wav_path.name, f, "audio/wav")}
        resp = requests.post(
            "https://api.openai.com/v1/audio/transcriptions",
            headers=headers,
            data=data,
            files=files,
            timeout=240,
        )

    if resp.status_code >= 300:
        raise RuntimeError(f"transcription failed {resp.status_code}: {resp.text}")
    return resp.json()


def extract_segments(obj: dict[str, Any]) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    raw = obj.get("segments")
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            start = float(item.get("start") or 0.0)
            end = float(item.get("end") or start)
            if end <= start:
                continue
            segments.append(
                {
                    "speaker": str(item.get("speaker") or item.get("speaker_label") or "unknown"),
                    "start": start,
                    "end": end,
                    "text": str(item.get("text") or "").strip(),
                }
            )
    return segments


def main() -> int:
    parser = argparse.ArgumentParser(description="Transcribe/diarize WAVs with OpenAI API.")
    parser.add_argument(
        "--input",
        default="scripts/diarization-poc/out/chunks",
        help="WAV file, folder, or glob",
    )
    parser.add_argument(
        "--out-dir",
        default="scripts/diarization-poc/out/transcripts",
    )
    parser.add_argument(
        "--model",
        default="gpt-4o-transcribe-diarize",
        help="e.g. gpt-4o-transcribe-diarize, gpt-4o-mini-transcribe, whisper-1",
    )
    parser.add_argument("--language", default=None)
    parser.add_argument("--temperature", type=float, default=None)
    parser.add_argument("--api-key-env", default="OPENAI_API_KEY")
    parser.add_argument("--max-retries", type=int, default=4)
    args = parser.parse_args()

    script_dir = pathlib.Path(__file__).resolve().parent
    load_dotenv(script_dir / ".env", override=False)
    load_dotenv(override=False)

    api_key = os.getenv(args.api_key_env)
    if not api_key:
        print(f"Missing {args.api_key_env}", file=sys.stderr)
        return 2

    wavs = collect_wavs(args.input)
    if not wavs:
        print("No WAV files found.", file=sys.stderr)
        return 1

    out_dir = pathlib.Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    for wav in wavs:
        result = None
        for attempt in range(1, args.max_retries + 1):
            try:
                result = transcribe_file(wav, api_key, args.model, args.language, args.temperature)
                break
            except Exception as exc:
                if attempt == args.max_retries:
                    print(f"[transcribe] failed {wav}: {exc}", file=sys.stderr)
                else:
                    sleep_s = min(20, 2 ** (attempt - 1))
                    print(f"[transcribe] retry {attempt}/{args.max_retries} for {wav.name} in {sleep_s}s ({exc})")
                    time.sleep(sleep_s)
        if result is None:
            continue

        out_path = out_dir / f"{wav.stem}.json"
        out_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
        segments = extract_segments(result)
        normalized_path = out_dir / f"{wav.stem}.segments.json"
        normalized_path.write_text(json.dumps({"segments": segments}, indent=2), encoding="utf-8")
        print(f"[transcribe] wrote {out_path} and {normalized_path} ({len(segments)} segments)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
