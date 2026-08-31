"""Regenerate the kaldi-fbank golden fixtures.

Run with the spike's venv, from this directory:

    ../../../../../../../experimental/speaker-id/.venv/bin/python make-fixtures.py

The golden vectors come from `torchaudio.compliance.kaldi.fbank` with
exactly the arguments WeSpeaker's `Speaker.compute_features` uses. The
TypeScript front end in `../../fbank.ts` must reproduce them bit-closely,
so that the ONNX model sees the same input the PyTorch model was fed.
"""

import json
import os
import pathlib
import subprocess
import sys

import numpy as np


def _spike_dir() -> pathlib.Path:
    """Locate experimental/speaker-id, which is untracked and so lives only
    in the main checkout, not in worktrees."""
    if env := os.environ.get("SPIKE_DIR"):
        return pathlib.Path(env)
    # Parent of the shared .git dir is the main checkout, even from a worktree.
    common = subprocess.check_output(
        ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd=pathlib.Path(__file__).resolve().parent,
        text=True,
    ).strip()
    return pathlib.Path(common).parent / "experimental" / "speaker-id"


spike = _spike_dir()
if not (spike / "wespeaker_compat.py").exists():
    raise SystemExit(f"speaker-id spike not found at {spike}; set SPIKE_DIR")
sys.path.insert(0, str(spike))
import wespeaker_compat  # noqa: E402

wespeaker_compat.apply()

import torch  # noqa: E402
import torchaudio  # noqa: E402
import torchaudio.compliance.kaldi as kaldi  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
CLIP = HERE / "parity-clip.wav"


def main() -> None:
    pcm, sr = torchaudio.load(str(CLIP))
    # Do not rescale to int16 range: torchaudio 2.x serves loads through
    # TorchCodec, which always returns normalized float32, and WeSpeaker
    # feeds that straight to kaldi.fbank.
    feats = kaldi.fbank(
        pcm,
        num_mel_bins=80,
        frame_length=25,
        frame_shift=10,
        sample_frequency=sr,
        window_type="hamming",
    )
    raw = feats.numpy().astype(np.float32)
    cmn = (feats - torch.mean(feats, dim=0)).numpy().astype(np.float32)

    (HERE / "parity-fbank-raw.f32").write_bytes(raw.tobytes())
    (HERE / "parity-fbank-cmn.f32").write_bytes(cmn.tobytes())
    (HERE / "parity-meta.json").write_text(
        json.dumps(
            {
                "sampleRate": int(sr),
                "samples": int(pcm.shape[1]),
                "frames": int(raw.shape[0]),
                "melBins": int(raw.shape[1]),
                "source": "torchaudio.compliance.kaldi.fbank, hamming, 80 mel, 25/10ms",
            },
            indent=2,
        )
        + "\n"
    )
    print(f"frames={raw.shape[0]} melBins={raw.shape[1]} dur={pcm.shape[1] / sr:.2f}s")


if __name__ == "__main__":
    main()
