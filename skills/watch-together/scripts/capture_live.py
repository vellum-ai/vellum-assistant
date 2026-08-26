#!/usr/bin/env python3
"""Capture a desktop in segments and feed completed segments to the editor."""

import argparse
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path


def positive_int(value):
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return number


def require_command(name):
    if shutil.which(name):
        return
    raise SystemExit(f"{name} was not found on PATH")


def detect_blackhole_device():
    try:
        result = subprocess.run(
            ["ffmpeg", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    for line in (result.stderr + result.stdout).splitlines():
        if "blackhole" not in line.lower():
            continue
        match = re.search(r"\[(\d+)\]", line)
        if match:
            return match.group(1)
    return None


def build_ffmpeg_command(
    system, chunks_dir, chunk_seconds, screen_device=None, audio_device=None, env=None
):
    env = os.environ if env is None else env
    command = ["ffmpeg", "-v", "warning", "-stats"]
    has_audio = bool(audio_device and audio_device.lower() != "none")

    if system == "Darwin":
        screen = screen_device or "2"
        audio = audio_device if has_audio else "none"
        command += [
            "-f",
            "avfoundation",
            "-capture_cursor",
            "0",
            "-probesize",
            "20M",
            "-framerate",
            "30",
            "-i",
            f"{screen}:{audio}",
        ]
    elif system == "Windows":
        screen = screen_device or "desktop"
        command += [
            "-f",
            "gdigrab",
            "-draw_mouse",
            "0",
            "-framerate",
            "30",
            "-i",
            screen,
        ]
        if has_audio:
            command += [
                "-thread_queue_size",
                "512",
                "-f",
                "dshow",
                "-i",
                f"audio={audio_device}",
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
            ]
    elif system == "Linux":
        screen = screen_device or env.get("DISPLAY")
        if not screen:
            raise ValueError("Linux screen capture requires DISPLAY or a screen device")
        command += [
            "-f",
            "x11grab",
            "-draw_mouse",
            "0",
            "-framerate",
            "30",
            "-i",
            screen,
        ]
        if has_audio:
            command += [
                "-thread_queue_size",
                "512",
                "-f",
                "pulse",
                "-i",
                audio_device,
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
            ]
    else:
        raise ValueError(f"unsupported platform: {system}")

    command += ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-r", "30"]
    if has_audio:
        command += ["-c:a", "aac", "-b:a", "128k"]
    else:
        command += ["-an"]
    command += [
        "-f",
        "segment",
        "-segment_time",
        str(chunk_seconds),
        "-reset_timestamps",
        "1",
        "-segment_format",
        "mp4",
        str(chunks_dir / "chunk-%03d.mp4"),
    ]
    return command


def chunk_is_ready(chunk):
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", str(chunk)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return result.returncode == 0


def process_chunks(script_dir, session_dir, conversation, chunk_seconds, final=False):
    chunks_dir = session_dir / "chunks"
    verdicts_dir = session_dir / "editor" / "verdicts"
    for chunk in sorted(chunks_dir.glob("chunk-*.mp4")):
        verdict = verdicts_dir / f"{chunk.stem}.json"
        if verdict.is_file():
            continue
        if not chunk_is_ready(chunk):
            if not final:
                break
            print(f"Skipping unreadable final segment: {chunk.name}", file=sys.stderr)
            continue
        result = subprocess.run(
            [
                sys.executable,
                str(script_dir / "editor.py"),
                str(chunk),
                str(session_dir),
                conversation,
                str(chunk_seconds),
            ]
        )
        if result.returncode != 0:
            print(f"Editor failed on {chunk.stem}", file=sys.stderr)


def stop_capture(capture, graceful_timeout=10, terminate_timeout=5):
    if capture.poll() is not None:
        return

    if capture.stdin:
        try:
            capture.stdin.write(b"q\n")
            capture.stdin.flush()
            capture.stdin.close()
        except (BrokenPipeError, OSError, ValueError):
            pass

    try:
        capture.wait(timeout=graceful_timeout)
        return
    except subprocess.TimeoutExpired:
        capture.terminate()

    try:
        capture.wait(timeout=terminate_timeout)
    except subprocess.TimeoutExpired:
        capture.kill()
        capture.wait()


def parse_args():
    parser = argparse.ArgumentParser(
        description="Capture the desktop in segments for Watch Together screen mode."
    )
    parser.add_argument("session_dir")
    parser.add_argument("conversation_key")
    parser.add_argument("chunk_seconds", nargs="?", type=positive_int, default=60)
    parser.add_argument(
        "screen_device",
        nargs="?",
        help="macOS AVFoundation index, Windows gdigrab target, or Linux X11 display",
    )
    parser.add_argument(
        "audio_device",
        nargs="?",
        help="macOS AVFoundation index, Windows DirectShow name, or Linux Pulse source",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    require_command("ffmpeg")
    require_command("ffprobe")

    system = platform.system()
    audio_device = args.audio_device
    if system == "Darwin" and not audio_device:
        audio_device = detect_blackhole_device()
        if audio_device:
            print("Audio: BlackHole system audio capture")
    if not audio_device:
        print("Audio: video-only mode. Pass an audio device to capture system audio.")

    session_dir = Path(args.session_dir).expanduser().resolve()
    script_dir = Path(__file__).resolve().parent
    chunks_dir = session_dir / "chunks"
    shutil.rmtree(chunks_dir, ignore_errors=True)
    shutil.rmtree(session_dir / "editor", ignore_errors=True)
    shutil.rmtree(session_dir / "wakes", ignore_errors=True)
    (session_dir / "editor-state.json").unlink(missing_ok=True)
    (session_dir / "editor" / "verdicts").mkdir(parents=True, exist_ok=True)
    chunks_dir.mkdir(parents=True, exist_ok=True)

    try:
        command = build_ffmpeg_command(
            system,
            chunks_dir,
            args.chunk_seconds,
            args.screen_device,
            audio_device,
        )
    except ValueError as error:
        raise SystemExit(str(error)) from error

    editor_name = os.environ.get("GEMINI_MODEL", "gemini-3-flash-preview")
    if not os.environ.get("GEMINI_API_KEY"):
        editor_name = "disabled"
        print("GEMINI_API_KEY is not set. The assistant will use fixed-cadence wakes.")

    print("Watch Together screen capture")
    print(f"Session: {session_dir}")
    print(f"Conversation: {args.conversation_key[:40]}...")
    print(f"Segments: {args.chunk_seconds}s")
    print(f"Editor: {editor_name}")
    print("Press Ctrl+C to stop")

    stop_requested = False

    def request_stop(_signum, _frame):
        nonlocal stop_requested
        stop_requested = True

    signal.signal(signal.SIGTERM, request_stop)
    capture = subprocess.Popen(command, stdin=subprocess.PIPE)
    interrupted = False
    try:
        while capture.poll() is None and not stop_requested:
            process_chunks(
                script_dir,
                session_dir,
                args.conversation_key,
                args.chunk_seconds,
            )
            time.sleep(3)
    except KeyboardInterrupt:
        interrupted = True
    finally:
        stop_capture(capture)
        process_chunks(
            script_dir,
            session_dir,
            args.conversation_key,
            args.chunk_seconds,
            final=True,
        )
        subprocess.run(
            [
                sys.executable,
                str(script_dir / "editor.py"),
                "--flush",
                str(session_dir),
                args.conversation_key,
                str(args.chunk_seconds),
            ]
        )
        print(f"Session complete. Wakes: {session_dir / 'wakes'}")
    if capture.returncode and not interrupted and not stop_requested:
        raise SystemExit(capture.returncode)


if __name__ == "__main__":
    main()
