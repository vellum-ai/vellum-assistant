"""Regenerate the kaldi-fbank golden fixtures.

These vectors are the spec for `../../fbank.ts`. The TypeScript front end must
reproduce them bit-closely, because a drifting fbank degrades embeddings
**silently** -- the model still returns a well-formed 192-dim vector, it is
just a worse one. `fbank-parity.test.ts` is what catches that.

The golden vectors come from `torchaudio.compliance.kaldi.fbank` with exactly
the arguments WeSpeaker's `Speaker.compute_features` uses.

Regenerating needs a Python environment with torch, torchaudio and numpy --
it is not part of the runtime, which is pure TypeScript and never shells out
to Python:

    uv venv --python 3.11 .venv
    uv pip install torch torchaudio numpy
    .venv/bin/python make-fixtures.py

`wespeaker_compat.py` sits beside this script and shims the torchaudio 2.x
APIs that WeSpeaker's import chain still expects; import it before torch.
"""

import json
import pathlib
import sys

import numpy as np


sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
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
