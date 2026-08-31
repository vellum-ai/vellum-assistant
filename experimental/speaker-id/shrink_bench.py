"""Measure the size/accuracy tradeoff of quantizing the ECAPA ONNX export.

Produces fp16 and int8 variants, then scores every variant against the torch
reference on the spike's clips: embedding fidelity (cosine vs torch) and the
same-vs-different speaker separation that actually decides whether it works.
"""
import os, time, shutil, pathlib
import numpy as np
import wespeaker_compat; wespeaker_compat.apply()
import torch, torchaudio
import torchaudio.compliance.kaldi as kaldi
from huggingface_hub import hf_hub_download

OUT = pathlib.Path("models"); OUT.mkdir(exist_ok=True)
src = hf_hub_download("Wespeaker/wespeaker-ecapa-tdnn512-LM", "voxceleb_ECAPA512_LM.onnx")
fp32 = OUT / "ecapa_fp32.onnx"
if not fp32.exists(): shutil.copy(src, fp32)

# ---- fp16 -----------------------------------------------------------------
fp16 = OUT / "ecapa_fp16.onnx"
if os.environ.get("WANT_FP16") and not fp16.exists():
    import onnx
    from onnxconverter_common import float16
    onnx.save(float16.convert_float_to_float16(
        onnx.load(fp32), keep_io_types=True,
        op_block_list=["Cast", "Shape", "Gather", "ReduceProd", "Div", "Expand",
                       "Unsqueeze", "Constant", "ConstantOfShape", "Range"]), fp16)

# ---- int8 dynamic ---------------------------------------------------------
int8 = OUT / "ecapa_int8.onnx"
if not int8.exists():
    from onnxruntime.quantization import quantize_dynamic, QuantType
    quantize_dynamic(str(fp32), str(int8), weight_type=QuantType.QInt8,
                     op_types_to_quantize=["Conv", "Gemm", "MatMul"],
                     extra_options={"MatMulConstBOnly": False})

# ---- features (exactly what wespeaker does) -------------------------------
def feats(path):
    pcm, sr = torchaudio.load(path)
    # Do NOT rescale to int16 range. wespeaker's code asks torchaudio for
    # normalize=False, but torchaudio 2.x serves loads through TorchCodec,
    # which always returns normalized float32 and ignores the flag. Feeding
    # int16-scale audio here silently drops fidelity to ~0.92.
    f = kaldi.fbank(pcm, num_mel_bins=80, frame_length=25, frame_shift=10,
                    sample_frequency=sr, window_type="hamming")
    f = f - torch.mean(f, dim=0)               # per-utterance CMN
    return f.unsqueeze(0).numpy().astype(np.float32)

clips = sorted(pathlib.Path("clips").glob("*.wav"))
F = {c.stem: feats(str(c)) for c in clips}

# ---- torch reference ------------------------------------------------------
import wespeaker
from speakerid import resolve_model_dir
import contextlib, io
with contextlib.redirect_stdout(io.StringIO()):
    ref_model = wespeaker.load_model(resolve_model_dir("Wespeaker/wespeaker-ecapa-tdnn512-LM"))
def norm(v):
    v = np.asarray(v, dtype=np.float32).reshape(-1); return v / np.linalg.norm(v)
# Reference goes through wespeaker's OWN feature path (file -> embedding), so a
# high onnx-fp32 fidelity score validates both the ONNX export and the fbank
# reimplementation above at the same time.
REF = {c.stem: norm(ref_model.extract_embedding(str(c)).numpy()) for c in clips}

# ---- run each variant -----------------------------------------------------
import onnxruntime as ort
def run(path):
    so = ort.SessionOptions(); so.log_severity_level = 3
    s = ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])
    itype = s.get_inputs()[0].type
    cast = np.float16 if "float16" in itype else np.float32
    out, lat = {}, []
    for k, v in F.items():
        t0 = time.perf_counter()
        e = s.run(None, {s.get_inputs()[0].name: v.astype(cast)})[0]
        lat.append((time.perf_counter() - t0) * 1000)
        out[k] = norm(e)
    return out, float(np.mean(lat))

def separation(E):
    names = list(E); same, diff = [], []
    for i in range(len(names)):
        for j in range(i+1, len(names)):
            s = float(np.dot(E[names[i]], E[names[j]]))
            (same if names[i].split("_")[0] == names[j].split("_")[0] else diff).append(s)
    return min(same) - max(diff), min(same), max(diff)

print(f"\n{'variant':<12}{'size':>9}{'vs torch':>11}{'worst same':>12}{'best diff':>11}{'separation':>12}{'ms/clip':>9}")
print("-" * 76)
gap, mn, mx = separation(REF)
print(f"{'torch fp32':<12}{'38.7 MB':>9}{'1.0000':>11}{mn:>12.3f}{mx:>11.3f}{gap:>+12.3f}{'-':>9}")
variants = [("onnx fp32", fp32)] + ([("onnx fp16", fp16)] if fp16.exists() else []) + [("onnx int8", int8)]
for label, path in variants:
    try:
        E, ms = run(path)
    except Exception as exc:
        print(f"{label:<12}{path.stat().st_size/1e6:>7.1f} MB   FAILED: {str(exc)[:44]}")
        continue
    fid = float(np.mean([np.dot(E[k], REF[k]) for k in E]))
    gap, mn, mx = separation(E)
    print(f"{label:<12}{path.stat().st_size/1e6:>7.1f} MB{fid:>11.4f}{mn:>12.3f}{mx:>11.3f}{gap:>+12.3f}{ms:>9.1f}")
