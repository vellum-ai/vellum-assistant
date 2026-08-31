#!/usr/bin/env python
"""Speaker identification spike built on WeSpeaker.

Enroll a voice profile from one or more short clips, then score a new clip
against every enrolled profile and report the best match.

This is a skunkworks spike. It is not wired into the Vellum voice pipeline.

Subcommands:
  synth     generate synthetic multi-speaker test clips via macOS `say`
  record    capture a clip from the default microphone
  enroll    add/replace a speaker profile from one or more clips
  identify  score a clip against all enrolled profiles
  matrix    pairwise similarity grid over clips, with separation stats
  profiles  list enrolled profiles
  forget    delete a profile
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import warnings
import wave
from datetime import datetime, timezone
from pathlib import Path

import wespeaker_compat

wespeaker_compat.apply()

import numpy as np  # noqa: E402

# torchaudio 2.x routes load() through TorchCodec, which always returns
# normalized float32 and warns that it ignored wespeaker's normalize=False.
# Harmless here, but it fires once per clip and drowns the output.
warnings.filterwarnings("ignore", message=".*normalize=False.*")

HERE = Path(__file__).resolve().parent
CLIPS_DIR = HERE / "clips"
PROFILE_DIR = HERE / "profiles"
PROFILE_NPZ = PROFILE_DIR / "profiles.npz"
PROFILE_META = PROFILE_DIR / "profiles.json"

# ECAPA-TDNN-512-LM, trained on VoxCeleb with large-margin finetuning.
DEFAULT_MODEL = "Wespeaker/wespeaker-ecapa-tdnn512-LM"

# Keys wespeaker's own Hub knows how to download (from ModelScope).
HUB_KEYS = {
    "chinese",
    "english",
    "campplus",
    "eres2net",
    "vblinkp",
    "vblinkf",
    "w2vbert2_mfa",
}

TARGET_RATE = 16000

# NOT tuned. Present so the demo prints a decision; always eyeball raw scores.
DEFAULT_THRESHOLD = 0.70


# --------------------------------------------------------------------------
# model
# --------------------------------------------------------------------------


def resolve_model_dir(spec: str) -> str:
    """Turn a model spec into something wespeaker.load_model accepts.

    wespeaker resolves its own Hub keys and local directories, but has no
    notion of a HuggingFace repo id, so we fetch those ourselves.
    """
    if spec in HUB_KEYS:
        return spec
    if os.path.isdir(spec):
        return spec
    if "/" in spec:
        from huggingface_hub import snapshot_download

        return snapshot_download(spec, allow_patterns=["avg_model.pt", "config.yaml"])
    raise SystemExit(
        f"Unrecognized model {spec!r}: expected a Hub key {sorted(HUB_KEYS)}, "
        "a local directory, or a HuggingFace repo id."
    )


def load_model(spec: str, use_vad: bool):
    import wespeaker

    model_dir = resolve_model_dir(spec)
    # wespeaker prints the entire training config to stdout on load.
    with contextlib.redirect_stdout(io.StringIO()):
        model = wespeaker.load_model(model_dir)
    model.set_device("cpu")
    if use_vad:
        model.set_vad(True)
    return model


# --------------------------------------------------------------------------
# audio
# --------------------------------------------------------------------------


def is_ready_wav(path: Path) -> bool:
    """True if already 16 kHz mono 16-bit WAV, so we can skip transcoding."""
    try:
        with wave.open(str(path), "rb") as w:
            return (
                w.getnchannels() == 1
                and w.getframerate() == TARGET_RATE
                and w.getsampwidth() == 2
            )
    except (wave.Error, EOFError):
        return False


def as_16k_mono(path: Path, stack: list[str]) -> str:
    """Return a path to a 16 kHz mono WAV, transcoding via ffmpeg if needed."""
    if not path.exists():
        raise SystemExit(f"No such audio file: {path}")
    if is_ready_wav(path):
        return str(path)
    if not shutil.which("ffmpeg"):
        raise SystemExit(f"{path} is not 16kHz mono WAV and ffmpeg is not installed.")
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    stack.append(tmp.name)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(path),
         "-ar", str(TARGET_RATE), "-ac", "1", "-sample_fmt", "s16", tmp.name],
        check=True,
    )
    return tmp.name


def duration_secs(path: Path) -> float | None:
    try:
        with wave.open(str(path), "rb") as w:
            return w.getnframes() / float(w.getframerate())
    except (wave.Error, EOFError):
        return None


# --------------------------------------------------------------------------
# embeddings
# --------------------------------------------------------------------------


def embed(model, path: Path) -> np.ndarray:
    """L2-normalized speaker embedding for one audio file."""
    stack: list[str] = []
    try:
        emb = model.extract_embedding(as_16k_mono(path, stack))
    finally:
        for f in stack:
            os.unlink(f)
    if emb is None:
        raise SystemExit(
            f"No embedding for {path} - the clip may be silent, or VAD removed "
            "all of it. Try a longer clip or drop --vad."
        )
    vec = emb.detach().cpu().numpy().astype(np.float32).reshape(-1)
    norm = float(np.linalg.norm(vec))
    if norm == 0.0:
        raise SystemExit(f"Degenerate (all-zero) embedding for {path}")
    return vec / norm


def centroid(vectors: list[np.ndarray]) -> np.ndarray:
    """Mean of L2-normalized embeddings, renormalized."""
    mean = np.mean(np.stack(vectors), axis=0)
    return mean / float(np.linalg.norm(mean))


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b))


# --------------------------------------------------------------------------
# profile store
# --------------------------------------------------------------------------


def load_profiles() -> dict[str, np.ndarray]:
    if not PROFILE_NPZ.exists():
        return {}
    with np.load(PROFILE_NPZ) as data:
        return {k: data[k] for k in data.files}


def load_meta() -> dict:
    if not PROFILE_META.exists():
        return {}
    return json.loads(PROFILE_META.read_text())


def save_profiles(profiles: dict[str, np.ndarray], meta: dict) -> None:
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    np.savez(PROFILE_NPZ, **profiles)
    PROFILE_META.write_text(json.dumps(meta, indent=2) + "\n")


# --------------------------------------------------------------------------
# synthetic test data
# --------------------------------------------------------------------------

# Distinct macOS voices standing in for distinct people. Accent and pitch vary
# a lot across these, so treat the resulting scores as an upper bound on how
# well real speakers separate.
SYNTH_VOICES = [
    ("daniel", "Daniel"),
    ("karen", "Karen"),
    ("fred", "Fred"),
]
IMPOSTOR_VOICE = ("kathy", "Kathy")

# Enrollment and test text differ on purpose. Reusing the same sentence would
# let the model match on content rather than on voice.
ENROLL_TEXT = (
    "The quick brown fox jumps over the lazy dog while the morning light "
    "spills across the kitchen table. I have been thinking about how strange "
    "it is that we measure a voice the same way we measure a fingerprint, "
    "as though a person were only ever one thing at a time."
)
TEST_TEXT = (
    "Yesterday afternoon the weather turned completely without warning and "
    "everyone in the office crowded around the window to watch the storm "
    "roll in. Somebody made coffee, and for about twenty minutes nobody "
    "pretended to do any work at all."
)


def say_to_wav(voice: str, text: str, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["say", "-v", voice, "--data-format=LEI16@16000", "-o", str(out), text],
        check=True,
    )


# --------------------------------------------------------------------------
# commands
# --------------------------------------------------------------------------


def cmd_synth(args) -> None:
    if not shutil.which("say"):
        raise SystemExit("`say` not found; synth only works on macOS.")
    made = []
    for slug, voice in SYNTH_VOICES + [IMPOSTOR_VOICE]:
        for kind, text in (("enroll", ENROLL_TEXT), ("test", TEST_TEXT)):
            out = CLIPS_DIR / f"{slug}_{kind}.wav"
            say_to_wav(voice, text, out)
            made.append(out)
    print(f"Wrote {len(made)} clips to {CLIPS_DIR}/")
    for p in made:
        d = duration_secs(p)
        print(f"  {p.name:<24} {d:5.1f}s")
    impostor = IMPOSTOR_VOICE[0]
    print(f"\n{impostor} is the unenrolled impostor: leave it out of `enroll`")
    print("so `identify` has something that should be rejected.")


def cmd_record(args) -> None:
    import sounddevice as sd

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    print(f"Recording {args.seconds}s at {TARGET_RATE} Hz mono. Speak now...")
    audio = sd.rec(
        int(args.seconds * TARGET_RATE),
        samplerate=TARGET_RATE,
        channels=1,
        dtype="int16",
    )
    sd.wait()
    with wave.open(str(out), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(TARGET_RATE)
        w.writeframes(audio.tobytes())
    print(f"Wrote {out} ({args.seconds}s)")


def cmd_enroll(args) -> None:
    model = load_model(args.model, args.vad)
    paths = [Path(p) for p in args.clips]
    vectors = [embed(model, p) for p in paths]
    profiles = load_profiles()
    meta = load_meta()
    profiles[args.name] = centroid(vectors)
    meta[args.name] = {
        "clips": [str(p) for p in paths],
        "n_clips": len(paths),
        "model": args.model,
        "vad": bool(args.vad),
        "enrolled_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    save_profiles(profiles, meta)
    print(f"Enrolled {args.name!r} from {len(paths)} clip(s) -> {PROFILE_NPZ}")
    if len(vectors) > 1:
        pairs = [
            cosine(vectors[i], vectors[j])
            for i in range(len(vectors))
            for j in range(i + 1, len(vectors))
        ]
        print(f"  self-consistency across enroll clips: "
              f"min {min(pairs):.3f}  mean {sum(pairs)/len(pairs):.3f}")


def cmd_identify(args) -> None:
    profiles = load_profiles()
    if not profiles:
        raise SystemExit("No profiles enrolled yet. Run `enroll` first.")
    model = load_model(args.model, args.vad)
    query = embed(model, Path(args.clip))

    scored = sorted(
        ((name, cosine(query, vec)) for name, vec in profiles.items()),
        key=lambda kv: kv[1],
        reverse=True,
    )
    best_name, best_score = scored[0]
    matched = best_score >= args.threshold

    print(f"\nClip: {args.clip}")
    if matched:
        print(f"Best match: {best_name} ({best_score:.3f})")
    else:
        print(f"No match (best was {best_name} at {best_score:.3f}, "
              f"below threshold {args.threshold:.2f})")

    if len(scored) > 1:
        margin = best_score - scored[1][1]
        print(f"Margin over runner-up ({scored[1][0]}): {margin:+.3f}")

    print("\nAll scores (threshold %.2f):" % args.threshold)
    for name, score in scored:
        flag = "MATCH" if score >= args.threshold else "     "
        bar = "#" * max(0, int(round(score * 40)))
        print(f"  {name:<12} {score:6.3f}  {flag}  {bar}")


def cmd_matrix(args) -> None:
    """Pairwise similarity over clips, plus same/different speaker separation.

    Speaker identity is taken from the filename prefix before the first
    underscore, so `alex_enroll.wav` and `alex_test.wav` count as the same
    person. That is what makes the separation stats meaningful.
    """
    paths = [Path(p) for p in args.clips]
    if len(paths) < 2:
        raise SystemExit("Need at least 2 clips.")
    model = load_model(args.model, args.vad)
    vectors = [embed(model, p) for p in paths]
    labels = [p.stem for p in paths]
    speakers = [lab.split("_")[0] for lab in labels]

    width = max(len(lab) for lab in labels) + 2
    print("\nPairwise cosine similarity:\n")
    print(" " * width + "".join(f"{lab[:7]:>8}" for lab in labels))
    for i, lab in enumerate(labels):
        row = "".join(f"{cosine(vectors[i], vectors[j]):8.3f}" for j in range(len(labels)))
        print(f"{lab:<{width}}{row}")

    same, diff = [], []
    for i in range(len(labels)):
        for j in range(i + 1, len(labels)):
            score = cosine(vectors[i], vectors[j])
            (same if speakers[i] == speakers[j] else diff).append(score)

    print()
    if same and diff:
        print(f"Same-speaker pairs      n={len(same):<3} "
              f"min {min(same):.3f}  mean {sum(same)/len(same):.3f}  max {max(same):.3f}")
        print(f"Different-speaker pairs n={len(diff):<3} "
              f"min {min(diff):.3f}  mean {sum(diff)/len(diff):.3f}  max {max(diff):.3f}")
        gap = min(same) - max(diff)
        print(f"\nSeparation (worst same - best different): {gap:+.3f}")
        if gap > 0:
            mid = (min(same) + max(diff)) / 2
            print(f"Cleanly separable. Any threshold in "
                  f"({max(diff):.3f}, {min(same):.3f}) splits these clips; midpoint {mid:.3f}.")
        else:
            print("OVERLAP: no single threshold separates these clips.")
    else:
        print("Need both same-speaker and different-speaker pairs for separation stats.")
        print("Name clips <speaker>_<take>.wav so identity can be inferred.")


def cmd_profiles(args) -> None:
    profiles = load_profiles()
    if not profiles:
        print("No profiles enrolled.")
        return
    meta = load_meta()
    print(f"{len(profiles)} profile(s) in {PROFILE_NPZ}:\n")
    for name, vec in profiles.items():
        info = meta.get(name, {})
        print(f"  {name:<12} dim={vec.shape[0]:<5} clips={info.get('n_clips', '?')} "
              f"enrolled={info.get('enrolled_at', '?')}")
    names = list(profiles)
    if len(names) > 1:
        print("\nCross-profile similarity (should be low):")
        for i in range(len(names)):
            for j in range(i + 1, len(names)):
                print(f"  {names[i]} vs {names[j]}: "
                      f"{cosine(profiles[names[i]], profiles[names[j]]):.3f}")


def cmd_forget(args) -> None:
    profiles = load_profiles()
    meta = load_meta()
    if args.name not in profiles:
        raise SystemExit(f"No profile named {args.name!r}")
    del profiles[args.name]
    meta.pop(args.name, None)
    save_profiles(profiles, meta)
    print(f"Removed profile {args.name!r}")


# --------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--model", default=DEFAULT_MODEL,
                        help=f"Hub key, local dir, or HF repo id (default: {DEFAULT_MODEL})")
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD,
                        help=f"match cutoff, untuned (default: {DEFAULT_THRESHOLD})")
    parser.add_argument("--vad", action="store_true",
                        help="run silero VAD to drop non-speech before embedding")

    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("synth", help="generate synthetic test clips via macOS `say`"
                   ).set_defaults(func=cmd_synth)

    p = sub.add_parser("record", help="record a clip from the microphone")
    p.add_argument("--seconds", type=float, default=10.0)
    p.add_argument("--out", required=True)
    p.set_defaults(func=cmd_record)

    p = sub.add_parser("enroll", help="enroll a speaker from one or more clips")
    p.add_argument("--name", required=True)
    p.add_argument("clips", nargs="+")
    p.set_defaults(func=cmd_enroll)

    p = sub.add_parser("identify", help="score a clip against enrolled profiles")
    p.add_argument("clip")
    p.set_defaults(func=cmd_identify)

    p = sub.add_parser("matrix", help="pairwise similarity grid over clips")
    p.add_argument("clips", nargs="+")
    p.set_defaults(func=cmd_matrix)

    sub.add_parser("profiles", help="list enrolled profiles").set_defaults(func=cmd_profiles)

    p = sub.add_parser("forget", help="delete a profile")
    p.add_argument("name")
    p.set_defaults(func=cmd_forget)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
