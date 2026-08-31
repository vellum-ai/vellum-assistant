"""Import shims that let wespeaker load on torchaudio 2.x.

wespeaker's model registry imports `wespeaker.frontend`, which unconditionally
imports `s3prl` for the self-supervised (WavLM/HuBERT) frontend. s3prl 0.4.x
still calls torchaudio APIs that were removed in torchaudio 2.x
(`set_audio_backend`, `torchaudio.sox_effects`), so that import chain explodes.

The ECAPA-TDNN model we use takes plain fbank features and never touches the
s3prl frontend, so we stub the module out before wespeaker is imported.
Import this module first, then `import wespeaker`.
"""

import sys
import types


def _install_torchaudio_shims() -> None:
    import torchaudio

    if not hasattr(torchaudio, "set_audio_backend"):
        torchaudio.set_audio_backend = lambda *a, **k: None
    if not hasattr(torchaudio, "get_audio_backend"):
        torchaudio.get_audio_backend = lambda *a, **k: None
    if not hasattr(torchaudio, "list_audio_backends"):
        torchaudio.list_audio_backends = lambda *a, **k: []


def _stub_s3prl() -> None:
    if "s3prl" in sys.modules:
        return

    class _Unavailable:
        def __init__(self, *a, **k):
            raise RuntimeError(
                "s3prl frontend is stubbed out in this spike; use an fbank model "
                "such as ECAPA-TDNN."
            )

    s3prl = types.ModuleType("s3prl")
    s3prl_nn = types.ModuleType("s3prl.nn")
    s3prl_nn.Featurizer = _Unavailable
    s3prl_nn.S3PRLUpstream = _Unavailable
    s3prl.nn = s3prl_nn

    sys.modules["s3prl"] = s3prl
    sys.modules["s3prl.nn"] = s3prl_nn


def apply() -> None:
    _install_torchaudio_shims()
    _stub_s3prl()
