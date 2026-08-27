#!/usr/bin/env python3
"""Extract dense 720p frames from a media time range."""

import argparse
import math
import shutil
import subprocess
from pathlib import Path


def timestamp(value):
    number = float(value)
    if not math.isfinite(number) or number < 0:
        raise argparse.ArgumentTypeError("must be a non-negative finite number")
    return number


def parse_args():
    parser = argparse.ArgumentParser(
        description="Extract 10fps 720p frames from a Watch Together source or segment."
    )
    parser.add_argument("source")
    parser.add_argument("output_dir")
    parser.add_argument("start_seconds", type=timestamp)
    parser.add_argument("end_seconds", type=timestamp)
    return parser.parse_args()


def main():
    args = parse_args()
    if args.end_seconds <= args.start_seconds:
        raise SystemExit("end_seconds must be greater than start_seconds")
    if not shutil.which("ffmpeg"):
        raise SystemExit("ffmpeg was not found on PATH")

    source = Path(args.source).expanduser().resolve()
    if not source.is_file():
        raise SystemExit(f"source file not found: {source}")

    rewind_dir = Path(args.output_dir).expanduser().resolve() / (
        f"rewind_{args.start_seconds:g}_{args.end_seconds:g}"
    )
    rewind_dir.mkdir(parents=True, exist_ok=True)
    for old_frame in rewind_dir.glob("r_*.jpg"):
        old_frame.unlink()

    print(
        f"Rewind: pulling 10fps from {args.start_seconds:g}s "
        f"to {args.end_seconds:g}s"
    )
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "warning",
            "-y",
            "-ss",
            str(args.start_seconds),
            "-to",
            str(args.end_seconds),
            "-i",
            str(source),
            "-vf",
            "scale=-2:720",
            "-r",
            "10",
            "-q:v",
            "2",
            str(rewind_dir / "r_%04d.jpg"),
        ],
        check=True,
    )
    frame_count = sum(1 for _ in rewind_dir.glob("r_*.jpg"))
    print(f"Rewind complete: {frame_count} frames at 720p in {rewind_dir}")


if __name__ == "__main__":
    main()
