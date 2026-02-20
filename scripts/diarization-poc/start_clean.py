#!/usr/bin/env python3
"""
Clear stale pipeline outputs and optionally start run_pipeline.py.
"""

from __future__ import annotations

import argparse
import pathlib
import shutil
import subprocess
import sys


def clear_dir(path: pathlib.Path) -> int:
    if not path.exists():
        return 0
    removed = 0
    for child in path.iterdir():
        if child.is_file() or child.is_symlink():
            child.unlink(missing_ok=True)
            removed += 1
        elif child.is_dir():
            shutil.rmtree(child, ignore_errors=True)
            removed += 1
    return removed


def maybe_remove(path: pathlib.Path) -> bool:
    if path.exists():
        path.unlink(missing_ok=True)
        return True
    return False


def ensure_within(root: pathlib.Path, path: pathlib.Path) -> None:
    root_resolved = root.resolve()
    path_resolved = path.resolve()
    try:
        path_resolved.relative_to(root_resolved)
    except ValueError as exc:
        raise RuntimeError(f"refusing to modify path outside {root_resolved}: {path_resolved}") from exc


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Reset stale diarization outputs and optionally launch the pipeline."
    )
    parser.add_argument("--run", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--reset-registry", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args, run_pipeline_args = parser.parse_known_args()

    script_dir = pathlib.Path(__file__).resolve().parent
    out_dir = script_dir / "out"
    chunks_dir = out_dir / "chunks"
    transcripts_dir = out_dir / "transcripts"
    labeled_dir = out_dir / "labeled"
    state_path = out_dir / "pipeline_state.json"
    registry_path = out_dir / "speaker_registry.json"

    for path in (chunks_dir, transcripts_dir, labeled_dir, state_path, registry_path):
        ensure_within(out_dir, path)

    for path in (chunks_dir, transcripts_dir, labeled_dir):
        path.mkdir(parents=True, exist_ok=True)

    actions: list[str] = []
    if args.dry_run:
        actions.append(f"would clear {chunks_dir}")
        actions.append(f"would clear {transcripts_dir}")
        actions.append(f"would clear {labeled_dir}")
        if state_path.exists():
            actions.append(f"would remove {state_path}")
        if args.reset_registry and registry_path.exists():
            actions.append(f"would remove {registry_path}")
    else:
        actions.append(f"cleared {chunks_dir} ({clear_dir(chunks_dir)} entries)")
        actions.append(f"cleared {transcripts_dir} ({clear_dir(transcripts_dir)} entries)")
        actions.append(f"cleared {labeled_dir} ({clear_dir(labeled_dir)} entries)")
        if maybe_remove(state_path):
            actions.append(f"removed {state_path}")
        if args.reset_registry and maybe_remove(registry_path):
            actions.append(f"removed {registry_path}")

    for line in actions:
        print(f"[start-clean] {line}")

    if not args.run:
        print("[start-clean] done (pipeline not started)")
        return 0

    cmd = [sys.executable, str(script_dir / "run_pipeline.py"), *run_pipeline_args]
    print(f"[start-clean] launching: {' '.join(cmd)}")
    proc = subprocess.Popen(cmd, cwd=script_dir)
    try:
        return proc.wait()
    except KeyboardInterrupt:
        print("[start-clean] interrupt received, stopping pipeline...")
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
