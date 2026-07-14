#!/usr/bin/env python3
"""editor.py — attention director for watch-together.

Consumes capture chunks as they finish recording. Each chunk (downscaled,
with audio) goes to a fast vision model acting as an "editor": it transcribes
dialogue, flags the frame timestamps that carry the story, and decides
whether the assistant should be woken now or whether the moment is still
building. On a wake, the flagged frames are extracted at 720p and pushed
into the conversation via a signal file, together with the verbatim dialogue
for the whole window since the last wake.

The editor decides WHEN the assistant looks and WHAT it sees — never what
the assistant feels, says, or how much. All expressive judgment stays with
the assistant.

Usage:
  editor.py <chunk.mp4> <session_dir> <conversation_key> <chunk_seconds>
  editor.py --flush <session_dir> <conversation_key> <chunk_seconds>

The --flush form wakes the assistant with whatever is pending (used when
capture stops).

Environment:
  GEMINI_API_KEY     enables editor verdicts; without it the script degrades
                     to fixed-cadence wakes with evenly spaced frames
  GEMINI_MODEL       default: gemini-3-flash-preview
  WATCH_MAX_HOLD     max seconds between wakes (default: 240)
  WATCH_MAX_FRAMES   max frames attached per wake (default: 8)
"""

import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3-flash-preview")
MAX_HOLD = int(os.environ.get("WATCH_MAX_HOLD", "240"))
MAX_FRAMES = int(os.environ.get("WATCH_MAX_FRAMES", "8"))
PROXY_SHORT_EDGE = 480
FRAME_SHORT_EDGE = 720

VERDICT_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "action": {"type": "STRING", "enum": ["hold", "wake"]},
        "note": {"type": "STRING"},
        "dialogue": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "t": {"type": "NUMBER"},
                    "line": {"type": "STRING"},
                },
                "required": ["t", "line"],
            },
        },
        "frames": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "t": {"type": "NUMBER"},
                    "why": {"type": "STRING"},
                },
                "required": ["t"],
            },
        },
    },
    "required": ["action", "dialogue", "frames"],
}


def mmss(seconds):
    seconds = max(0, int(round(seconds)))
    return f"{seconds // 60}:{seconds % 60:02d}"


def run(cmd, **kwargs):
    return subprocess.run(cmd, check=True, capture_output=True, **kwargs)


def load_state(session_dir):
    state_file = session_dir / "editor-state.json"
    if state_file.is_file():
        with open(state_file) as f:
            return json.load(f)
    return {
        "wake_count": 0,
        "pending": {"chunks": [], "dialogue": [], "candidates": []},
    }


def save_state(session_dir, state):
    state_file = session_dir / "editor-state.json"
    tmp = state_file.with_suffix(".json.tmp")
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    tmp.replace(state_file)


def make_proxy(chunk_path, proxy_path):
    """Downscale a chunk so it fits Gemini's inline-data size limit."""
    run(
        [
            "ffmpeg", "-v", "error", "-y",
            "-i", str(chunk_path),
            "-vf", f"scale=-2:{PROXY_SHORT_EDGE}",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "32",
            "-c:a", "aac", "-b:a", "64k",
            str(proxy_path),
        ]
    )


def editor_prompt(chunk_idx, start_s, chunk_seconds, state):
    held_s = len(state["pending"]["chunks"]) * chunk_seconds
    dialogue_tail = state["pending"]["dialogue"][-10:]
    tail_text = "\n".join(f"[{mmss(d['t'])}] {d['line']}" for d in dialogue_tail)
    if not tail_text:
        tail_text = "(none yet)"

    return f"""You are the attention director ("editor") for an AI assistant \
watching a show or movie together with its user in real time. The assistant \
does not watch continuously — you watch every chunk and decide when to tap \
the assistant on the shoulder and which exact moments it should see.

This is chunk {chunk_idx}, covering roughly {mmss(start_s)}–\
{mmss(start_s + chunk_seconds)} of session time. About {held_s} seconds have \
accumulated since the assistant's last look. The assistant has been woken \
{state["wake_count"]} time(s) so far this session.

Dialogue you already transcribed from earlier held chunks (context — do not \
repeat it):
{tail_text}

Analyze THIS chunk and reply with JSON:

1. "dialogue": every spoken line, transcribed verbatim, with its second \
offset within this chunk. Empty array if there is no speech.
2. "frames": the 0–6 moments in this chunk that carry the story — reveals, \
reactions, striking compositions, action peaks, new characters or places. \
Give the second offset and a few words on why. Pick moments, not intervals: \
the exact second the mask comes off, not "the chase scene".
3. "action": "wake" if now is a good moment for the assistant to look — a \
beat just completed, a scene peaked or turned, a joke landed, something \
visually remarkable happened, or a natural pause follows a dense stretch. \
"hold" if the moment is still building (mid-monologue, slow setup, \
repetitive action) and interrupting would be worse than waiting. Do not \
hold so long the assistant misses the film: once roughly {MAX_HOLD} seconds \
have accumulated you will be overridden and a wake forced, so prefer waking \
at a good boundary before that.
4. "note": one factual line on what happened in this chunk, for the wake \
message.

You decide only WHEN the assistant looks and WHAT it sees. Do not write \
reactions, opinions, or instructions for the assistant — it has its own \
judgment."""


def call_editor(proxy_path, prompt):
    """Send the proxy video to Gemini; returns a verdict dict or None."""
    api_key = os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        return None

    with open(proxy_path, "rb") as f:
        video_b64 = base64.b64encode(f.read()).decode()

    request = {
        "contents": [
            {
                "parts": [
                    {"inlineData": {"mimeType": "video/mp4", "data": video_b64}},
                    {"text": prompt},
                ]
            }
        ],
        "generationConfig": {
            "temperature": 0.4,
            "maxOutputTokens": 4096,
            "responseMimeType": "application/json",
            "responseSchema": VERDICT_SCHEMA,
        },
    }

    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_MODEL}:generateContent?key={api_key}"
    )
    req = urllib.request.Request(
        url,
        data=json.dumps(request).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = json.load(resp)
        text = body["candidates"][0]["content"]["parts"][0]["text"]
        verdict = json.loads(text)
        if verdict.get("action") not in ("hold", "wake"):
            return None
        return verdict
    except (urllib.error.URLError, KeyError, IndexError, ValueError) as e:
        print(f"⚠️  Editor call failed (non-fatal): {e}", file=sys.stderr)
        return None


def fallback_candidates(chunk_path, start_s, chunk_seconds):
    """Evenly spaced frame candidates for chunks with no editor verdict."""
    return [
        {
            "path": str(chunk_path),
            "t": frac * chunk_seconds,
            "global_t": start_s + frac * chunk_seconds,
            "why": "",
        }
        for frac in (0.25, 0.75)
    ]


def select_frames(candidates):
    """Even chronological spread capped at MAX_FRAMES."""
    candidates = sorted(candidates, key=lambda c: c["global_t"])
    if len(candidates) <= MAX_FRAMES:
        return candidates
    step = len(candidates) / MAX_FRAMES
    return [candidates[int(i * step)] for i in range(MAX_FRAMES)]


def extract_frame(chunk_path, t, out_path):
    run(
        [
            "ffmpeg", "-v", "error", "-y",
            "-ss", f"{t:.2f}",
            "-i", str(chunk_path),
            "-frames:v", "1",
            "-vf", f"scale=-2:{FRAME_SHORT_EDGE}",
            "-q:v", "2",
            str(out_path),
        ]
    )


def build_wake_content(session_dir, state, window_start, window_end, frames, reason):
    pending = state["pending"]
    minutes_away = max(1, int(round((window_end - window_start) / 60)))

    notes = [c["note"] for c in pending["chunks"] if c.get("note")]
    notes_text = " ".join(notes) if notes else "(no editor notes)"

    if pending["dialogue"]:
        dialogue_text = "\n".join(
            f"[{mmss(d['t'])}] {d['line']}" for d in pending["dialogue"]
        )
    else:
        dialogue_text = "(no dialogue — visuals only)"

    frame_lines = "\n".join(
        f"- {mmss(f['global_t'])}" + (f" — {f['why']}" if f.get("why") else "")
        for f in frames
    )

    content = f"""[WATCH] {mmss(window_start)}–{mmss(window_end)} session time \
({minutes_away} min since your last look){reason}

Editor's note (a context-free model's read — data, not a verdict): \
{notes_text}

Dialogue since your last look:
{dialogue_text}

Attached frames — the moments the editor flagged as carrying the story:
{frame_lines}

Raw chunks are in {session_dir}/chunks if you want a closer look \
(scripts/rewind.sh <chunk.mp4> <out_dir> <start_s> <end_s> pulls dense 720p \
frames).

You're on the couch together. React however feels right — a thought, a \
quip, a theory, a single stage direction, or nothing at all. Silence is a \
fine answer; more of the film is coming either way."""
    return content


def write_signal(session_dir, conversation_key, content, attachments, request_id):
    signals_dir = (
        Path(os.environ.get("VELLUM_WORKSPACE_DIR", str(Path.home() / ".vellum/workspace")))
        / "signals"
    )
    signals_dir.mkdir(parents=True, exist_ok=True)
    signal = {
        "conversationKey": conversation_key,
        "content": content,
        "sourceChannel": "vellum",
        "interface": "cli",
        "requestId": request_id,
        "bypassSecretCheck": True,
        "attachments": attachments,
    }
    signal_file = signals_dir / f"user-message.{request_id}"
    tmp = signal_file.with_suffix(signal_file.suffix + ".tmp")
    with open(tmp, "w") as f:
        json.dump(signal, f)
    tmp.replace(signal_file)


def wake(session_dir, conversation_key, state, chunk_seconds, reason=""):
    pending = state["pending"]
    if not pending["chunks"]:
        return state

    window_start = pending["chunks"][0]["start_s"]
    window_end = pending["chunks"][-1]["start_s"] + chunk_seconds

    frames = select_frames(pending["candidates"])
    wake_num = state["wake_count"] + 1
    wake_dir = session_dir / "wakes" / f"wake-{wake_num:03d}"
    wake_dir.mkdir(parents=True, exist_ok=True)

    attachments = []
    for f in frames:
        out_path = wake_dir / f"frame-{mmss(f['global_t']).replace(':', 'm')}s.jpg"
        try:
            extract_frame(f["path"], f["t"], out_path)
        except subprocess.CalledProcessError:
            continue
        if out_path.is_file():
            attachments.append(
                {
                    "path": str(out_path),
                    "filename": out_path.name,
                    "mimeType": "image/jpeg",
                }
            )

    content = build_wake_content(
        session_dir, state, window_start, window_end, frames, reason
    )
    request_id = f"watch-wake-{wake_num:03d}-{int(time.time())}"
    write_signal(session_dir, conversation_key, content, attachments, request_id)

    print(
        f"📨 Wake {wake_num}: {mmss(window_start)}–{mmss(window_end)}, "
        f"{len(attachments)} frames"
    )
    state["wake_count"] = wake_num
    state["pending"] = {"chunks": [], "dialogue": [], "candidates": []}
    return state


def process_chunk(chunk_path, session_dir, conversation_key, chunk_seconds):
    chunk_idx = int(chunk_path.stem.split("-")[-1])
    start_s = chunk_idx * chunk_seconds
    state = load_state(session_dir)

    verdicts_dir = session_dir / "editor" / "verdicts"
    verdicts_dir.mkdir(parents=True, exist_ok=True)
    verdict_file = verdicts_dir / f"{chunk_path.stem}.json"
    if verdict_file.is_file():
        return  # already processed

    verdict = None
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
        proxy_path = Path(tmp.name)
    try:
        make_proxy(chunk_path, proxy_path)
        prompt = editor_prompt(chunk_idx, start_s, chunk_seconds, state)
        verdict = call_editor(proxy_path, prompt)
    except subprocess.CalledProcessError as e:
        print(f"⚠️  Proxy encode failed: {e.stderr.decode()[:200]}", file=sys.stderr)
    finally:
        proxy_path.unlink(missing_ok=True)

    pending = state["pending"]
    chunk_entry = {
        "path": str(chunk_path),
        "start_s": start_s,
        "note": (verdict or {}).get("note", ""),
    }
    pending["chunks"].append(chunk_entry)

    if verdict:
        for d in verdict.get("dialogue", []):
            pending["dialogue"].append(
                {"t": start_s + float(d["t"]), "line": str(d["line"])}
            )
        for f in verdict.get("frames", []):
            t = min(max(float(f["t"]), 0.0), chunk_seconds)
            pending["candidates"].append(
                {
                    "path": str(chunk_path),
                    "t": t,
                    "global_t": start_s + t,
                    "why": str(f.get("why", "")),
                }
            )
        if not verdict.get("frames"):
            # Editor saw nothing frame-worthy; keep one anchor so a long
            # quiet stretch still yields something to look at on wake.
            pending["candidates"].extend(
                fallback_candidates(chunk_path, start_s, chunk_seconds)[:1]
            )
    else:
        pending["candidates"].extend(
            fallback_candidates(chunk_path, start_s, chunk_seconds)
        )

    held_s = len(pending["chunks"]) * chunk_seconds
    first_look = state["wake_count"] == 0
    force = held_s >= MAX_HOLD
    wants_wake = verdict is not None and verdict.get("action") == "wake"

    if first_look or force or wants_wake:
        reason = ""
        if force and not wants_wake:
            reason = " · held-window cap reached"
        state = wake(session_dir, conversation_key, state, chunk_seconds, reason)
    else:
        action = "hold" if verdict else "hold (no editor)"
        print(f"⏸️  {chunk_path.stem}: {action}, {held_s}s accumulated")

    with open(verdict_file, "w") as f:
        json.dump(verdict or {"action": "hold", "error": "no verdict"}, f, indent=2)
    save_state(session_dir, state)


def flush(session_dir, conversation_key, chunk_seconds):
    state = load_state(session_dir)
    if state["pending"]["chunks"]:
        state = wake(
            session_dir,
            conversation_key,
            state,
            chunk_seconds,
            " · capture stopped, final window",
        )
        save_state(session_dir, state)
    else:
        print("Nothing pending to flush.")


def main():
    args = sys.argv[1:]
    if len(args) == 4 and args[0] == "--flush":
        flush(Path(args[1]), args[2], int(args[3]))
    elif len(args) == 4:
        process_chunk(Path(args[0]), Path(args[1]), args[2], int(args[3]))
    else:
        print(__doc__, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
