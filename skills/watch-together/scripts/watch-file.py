#!/usr/bin/env python3
"""watch-file.py — source-mode watch-together.

Plays a media file in mpv and feeds each watched window to the editor by
reading the source file directly — no screen capture, no loopback audio
driver, no capture encode. The movie can be fullscreen on any display.

How it works:
1. Launches mpv with a JSON IPC socket and polls playback position.
2. Each time playback crosses a window boundary (default 60s), that window
   is handed to editor.py, which trims a proxy straight from the source
   file and runs the usual hold/wake flow. Frames attached to wakes are
   extracted from the source at full quality, and all timestamps are media
   time.
3. Subtitles — a sidecar .srt or the first text subtitle stream in the
   file — become the verbatim dialogue in wakes; the editor skips
   transcription. Without subtitles the editor transcribes from audio.
4. Pause stops the flow (position stops crossing boundaries). Seeks resync:
   windows the user skipped are never processed; re-watched windows are not
   re-sent.
5. When mpv exits, the final partial window is processed and any held
   window is flushed.

Usage: watch-file.py <media_file> <session_dir> <conversation_key> [chunk_seconds]

Environment (in addition to editor.py's):
  WATCH_MPV_ARGS   extra args appended to the mpv command line
"""

import argparse
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import editor  # noqa: E402

POLL_S = 2.0
MIN_FINAL_WINDOW_S = 10.0
TEXT_SUB_CODECS = {"subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text"}

SRT_TIME = re.compile(
    r"(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)"
)


def read_when_available(
    read, available, timeout, clock=time.monotonic, sleep=time.sleep
):
    deadline = clock() + timeout
    while True:
        byte_count = available()
        if byte_count > 0:
            return read(min(byte_count, 65536))
        remaining = deadline - clock()
        if remaining <= 0:
            return None
        sleep(min(0.02, remaining))


def parse_srt(path):
    """Parse an .srt into [(start_seconds, text)], tags stripped."""
    entries = []
    text = Path(path).read_text(errors="replace")
    for block in re.split(r"\n\s*\n", text):
        lines = block.strip().splitlines()
        for i, line in enumerate(lines):
            m = SRT_TIME.search(line)
            if not m:
                continue
            start = (
                int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3]) + int(m[4]) / 1000
            )
            content = " ".join(lines[i + 1 :]).strip()
            content = re.sub(r"<[^>]+>", "", content)
            content = re.sub(r"\{[^}]*\}", "", content).strip()
            if content:
                entries.append((start, content))
            break
    entries.sort(key=lambda e: e[0])
    return entries


def find_text_sub_stream(media):
    """Index (within subtitle streams) of the first text-based track, or None."""
    result = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-select_streams", "s",
            "-show_entries", "stream=codec_name",
            "-of", "json",
            str(media),
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None
    try:
        streams = json.loads(result.stdout).get("streams", [])
    except ValueError:
        return None
    for n, stream in enumerate(streams):
        if stream.get("codec_name") in TEXT_SUB_CODECS:
            return n
    return None


def media_duration(media):
    """Duration in seconds via ffprobe, or None if unavailable."""
    result = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(media),
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None
    try:
        return float(result.stdout.strip())
    except ValueError:
        return None


def load_subtitles(media, session_dir):
    """Sidecar .srt, else first embedded text track. Returns entries or None."""
    sidecar = media.with_suffix(".srt")
    if sidecar.is_file():
        print(f"💬 Subtitles: {sidecar.name} (sidecar)")
        return parse_srt(sidecar)

    n = find_text_sub_stream(media)
    if n is None:
        print("💬 Subtitles: none found — the editor will transcribe from audio")
        return None

    extracted = session_dir / "subs.srt"
    result = subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y",
            "-i", str(media),
            "-map", f"0:s:{n}",
            str(extracted),
        ],
        capture_output=True,
    )
    if result.returncode != 0 or not extracted.is_file():
        print("💬 Subtitles: extraction failed — the editor will transcribe from audio")
        return None
    print(f"💬 Subtitles: embedded track {n}")
    return parse_srt(extracted)


class MpvIpc:
    """Minimal client for mpv JSON IPC over a Unix socket or Windows pipe."""

    def __init__(self, endpoint, timeout=20.0):
        deadline = time.monotonic() + timeout
        while True:
            try:
                if os.name == "nt":
                    self.stream = open(endpoint, "r+b", buffering=0)
                else:
                    self.stream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    self.stream.connect(str(endpoint))
                break
            except OSError:
                if os.name != "nt" and hasattr(self, "stream"):
                    self.stream.close()
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.3)
        if os.name != "nt":
            self.stream.settimeout(5.0)
        self.buf = b""
        self.req = 0

    def close(self):
        self.stream.close()

    def send(self, data):
        if os.name == "nt":
            self.stream.write(data)
            self.stream.flush()
        else:
            self.stream.sendall(data)

    def windows_pipe_available(self):
        import ctypes
        import msvcrt
        from ctypes import wintypes

        available = wintypes.DWORD()
        peek_named_pipe = ctypes.windll.kernel32.PeekNamedPipe
        peek_named_pipe.argtypes = [
            wintypes.HANDLE,
            ctypes.c_void_p,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
            ctypes.POINTER(wintypes.DWORD),
            ctypes.POINTER(wintypes.DWORD),
        ]
        peek_named_pipe.restype = wintypes.BOOL
        handle = msvcrt.get_osfhandle(self.stream.fileno())
        if not peek_named_pipe(handle, None, 0, None, ctypes.byref(available), None):
            raise ctypes.WinError()
        return available.value

    def receive(self, timeout):
        if os.name == "nt":
            return read_when_available(
                self.stream.read,
                self.windows_pipe_available,
                timeout,
            )
        return self.stream.recv(65536)

    def get_property(self, name):
        """Returns the property value, or None if unavailable."""
        self.req += 1
        msg = json.dumps({"command": ["get_property", name], "request_id": self.req})
        self.send(msg.encode() + b"\n")
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            while b"\n" in self.buf:
                line, self.buf = self.buf.split(b"\n", 1)
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                # Event messages (no request_id) are skipped.
                if obj.get("request_id") == self.req:
                    if obj.get("error") == "success":
                        return obj.get("data")
                    return None
            try:
                data = self.receive(max(0, deadline - time.monotonic()))
            except socket.timeout:
                return None
            if data is None:
                return None
            if not data:
                raise ConnectionError("mpv socket closed")
            self.buf += data
        return None


def parse_args():
    parser = argparse.ArgumentParser(
        description="Play a local media file and feed watched windows to Watch Together."
    )
    parser.add_argument("media_file")
    parser.add_argument("session_dir")
    parser.add_argument("conversation_key")
    parser.add_argument("chunk_seconds", nargs="?", type=int, default=60)
    args = parser.parse_args()
    if args.chunk_seconds <= 0:
        parser.error("chunk_seconds must be greater than zero")
    return args


def install_hint(command):
    if sys.platform == "darwin":
        return f"install with: brew install {command}"
    if os.name == "nt":
        return f"install {command} and add it to PATH"
    return f"install {command} with your system package manager"


def split_mpv_args(value):
    if not value:
        return []
    if os.name != "nt":
        return shlex.split(value)

    import ctypes
    from ctypes import wintypes

    command_line_to_argv = ctypes.windll.shell32.CommandLineToArgvW
    command_line_to_argv.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_int)]
    command_line_to_argv.restype = ctypes.POINTER(wintypes.LPWSTR)
    local_free = ctypes.windll.kernel32.LocalFree
    local_free.argtypes = [ctypes.c_void_p]
    local_free.restype = ctypes.c_void_p

    argument_count = ctypes.c_int()
    arguments = command_line_to_argv(
        f"watch-together {value}", ctypes.byref(argument_count)
    )
    if not arguments:
        raise OSError(ctypes.get_last_error(), "could not parse WATCH_MPV_ARGS")
    try:
        return [arguments[index] for index in range(1, argument_count.value)]
    finally:
        local_free(arguments)


def process_window(media, session_dir, conv, chunk_s, idx, subs, duration=None):
    dialogue = None
    if subs is not None:
        start = idx * chunk_s
        end = start + (duration or chunk_s)
        dialogue = [
            {"t": t, "line": line} for (t, line) in subs if start <= t < end
        ]
    editor.process_chunk(
        media,
        session_dir,
        conv,
        chunk_s,
        idx=idx,
        from_source=True,
        duration=duration,
        provided_dialogue=dialogue,
    )


def main():
    args = parse_args()
    media = Path(args.media_file).expanduser().resolve()
    session_dir = Path(args.session_dir).expanduser().resolve()
    conv = args.conversation_key
    chunk_s = args.chunk_seconds

    if not media.is_file():
        sys.exit(f"Media file not found: {media}")
    if not shutil.which("mpv"):
        sys.exit(f"mpv not found. {install_hint('mpv')}")
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        sys.exit(f"ffmpeg or ffprobe not found. {install_hint('ffmpeg')}")

    # Fresh session state (the media itself is untouched)
    shutil.rmtree(session_dir / "editor", ignore_errors=True)
    shutil.rmtree(session_dir / "wakes", ignore_errors=True)
    session_dir.mkdir(parents=True, exist_ok=True)
    (session_dir / "editor-state.json").unlink(missing_ok=True)

    if not os.environ.get("GEMINI_API_KEY"):
        print("⚠️  GEMINI_API_KEY not set — editor disabled.")
        print(
            f"   The assistant will be woken every "
            f"{editor.MAX_HOLD // 60} min with evenly spaced frames."
        )

    subs = load_subtitles(media, session_dir)

    if os.name == "nt":
        ipc_endpoint = rf"\\.\pipe\vellum-watch-{os.getpid()}"
    else:
        ipc_endpoint = session_dir / "mpv.sock"
        ipc_endpoint.unlink(missing_ok=True)
    mpv_cmd = ["mpv", "--fs", f"--input-ipc-server={ipc_endpoint}", str(media)]
    mpv_cmd += split_mpv_args(os.environ.get("WATCH_MPV_ARGS", ""))
    mpv = subprocess.Popen(mpv_cmd)

    print("━" * 41)
    print("🎬 Watch Together — Source Mode")
    print("━" * 41)
    print(f"   Media:        {media.name}")
    print(f"   Session:      {session_dir}")
    print(f"   Conversation: {conv[:40]}...")
    print(f"   Windows:      {chunk_s}s")
    print()
    print("   Watch normally — pause pauses the flow, quitting mpv ends it")
    print("━" * 41)

    try:
        ipc = MpvIpc(ipc_endpoint)
    except OSError:
        mpv.terminate()
        sys.exit("Could not connect to mpv IPC")

    next_idx = None
    last_pos = None
    last_wall = None
    last_speed = 1.0
    try:
        while mpv.poll() is None:
            time.sleep(POLL_S)
            try:
                pos = ipc.get_property("playback-time")
                if not isinstance(pos, (int, float)):
                    continue
                now = time.monotonic()

                if next_idx is None:
                    next_idx = int(pos // chunk_s)
                elif last_pos is not None:
                    # Seek detection: playback advanced far from what
                    # wall-clock (at the current speed) predicts. Pauses
                    # predict overshoot and land harmlessly on the same
                    # window; processed windows are skip-guarded by their
                    # verdict files.
                    speed = ipc.get_property("speed") or 1.0
                    last_speed = speed
                    expected = (now - last_wall) * speed
                    if abs((pos - last_pos) - expected) > max(10.0, 0.5 * expected):
                        resync = int(pos // chunk_s)
                        if resync != next_idx:
                            print(f"⏩ Seek detected — resyncing to window {resync}")
                            next_idx = resync
            except ConnectionError:
                break

            while pos >= (next_idx + 1) * chunk_s:
                process_window(media, session_dir, conv, chunk_s, next_idx, subs)
                next_idx += 1

            last_pos = pos
            last_wall = now
    except KeyboardInterrupt:
        pass
    finally:
        ipc.close()
        if mpv.poll() is None:
            mpv.terminate()
        if next_idx is not None and last_pos is not None:
            # Polling can lag mpv's exit by a poll interval (more while a
            # window is processing), so a file watched to the end may have
            # unseen windows past the last polled position. When the end of
            # the file was reachable within that gap, credit playback to the
            # end; otherwise (early quit) trust the last polled position.
            end_pos = last_pos
            duration = media_duration(media)
            if duration is not None:
                gap_s = (time.monotonic() - last_wall + POLL_S) * last_speed
                if duration - last_pos <= gap_s:
                    end_pos = max(duration, last_pos)
            while end_pos >= (next_idx + 1) * chunk_s:
                process_window(media, session_dir, conv, chunk_s, next_idx, subs)
                next_idx += 1
            tail = end_pos - next_idx * chunk_s
            if tail >= MIN_FINAL_WINDOW_S:
                process_window(
                    media, session_dir, conv, chunk_s, next_idx, subs, duration=tail
                )
        editor.flush(session_dir, conv, chunk_s)
        print()
        print("✅ Session complete!")
        print(f"   Wakes: {session_dir}/wakes")


if __name__ == "__main__":
    main()
