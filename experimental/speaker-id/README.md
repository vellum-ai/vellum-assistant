# Speaker ID spike (WeSpeaker)

Skunkworks spike for the presence/perception layer: can an open-source model
tell us *who is speaking*? Replaces the dropped Picovoice Eagle trial. Runs
fully local, MIT licensed, no per-minute metering, no API calls.

**Not wired into anything.** Nothing here imports from or is imported by the
Vellum voice pipeline.

## Setup

```bash
cd experimental/speaker-id
uv venv --python 3.11 .venv
VIRTUAL_ENV=.venv uv pip install -r requirements.txt
```

Python 3.11 is pinned deliberately: the repo default is 3.14, which has no
torch wheels.

The ECAPA-TDNN-512-LM weights (~80 MB) download from HuggingFace on first use
and are cached in `~/.cache/huggingface`.

## Try it

```bash
# 1. Generate synthetic multi-speaker clips (macOS `say`)
.venv/bin/python speakerid.py synth

# 2. Enroll three voices; leave `kathy` out as an unenrolled impostor
.venv/bin/python speakerid.py enroll --name daniel clips/daniel_enroll.wav
.venv/bin/python speakerid.py enroll --name karen  clips/karen_enroll.wav
.venv/bin/python speakerid.py enroll --name fred   clips/fred_enroll.wav

# 3. Recognize. Test clips are *different speech* from the enrollment clips.
.venv/bin/python speakerid.py identify clips/daniel_test.wav
.venv/bin/python speakerid.py identify clips/kathy_test.wav   # should reject

# 4. Eyeball separation across every clip pair
.venv/bin/python speakerid.py matrix clips/*.wav
```

### Real voices

```bash
.venv/bin/python speakerid.py record --seconds 10 --out clips/alex_enroll.wav
.venv/bin/python speakerid.py enroll --name alex clips/alex_enroll.wav
.venv/bin/python speakerid.py record --seconds 10 --out clips/alex_test.wav
.venv/bin/python speakerid.py identify clips/alex_test.wav
```

Enrollment accepts several clips and averages them, which is what you want for
a durable profile:

```bash
.venv/bin/python speakerid.py enroll --name alex clips/alex_1.wav clips/alex_2.wav clips/alex_3.wav
```

Add `--vad` to strip non-speech before embedding. Worth it for real recordings
with leading silence or room noise; unnecessary for the synthetic clips.

## Results (synthetic voices, 2026-08-28)

Model: `Wespeaker/wespeaker-ecapa-tdnn512-LM` (ECAPA_TDNN_GLOB_c512, 192-dim,
fbank80). CPU, ~1s per clip on an M-series Mac.

Recognition, enroll and test text deliberately different:

| test clip | best match | score | runner-up | margin |
|---|---|---|---|---|
| daniel_test | daniel | 0.964 | fred 0.243 | +0.721 |
| karen_test  | karen  | 0.961 | daniel 0.091 | +0.870 |
| fred_test   | fred   | 0.967 | daniel 0.223 | +0.744 |
| kathy_test  | *(rejected)* | 0.444 | — | correctly below threshold |

Pairwise over all 8 clips:

```
Same-speaker pairs      n=4   min 0.960  mean 0.963  max 0.967
Different-speaker pairs n=24  min 0.010  mean 0.179  max 0.451
Separation (worst same - best different): +0.509
```

3/3 correct, impostor rejected, and the untuned 0.70 threshold happens to sit
almost exactly at the midpoint of the gap (0.706).

## Read this before trusting those numbers

**The synthetic result is an upper bound, not a forecast.** macOS TTS voices are
deterministic, noise-free, and separated by accent and pitch far more than real
people are. Two humans of the same gender and accent, on a real mic in a real
room, will land much closer together. Published ECAPA VoxCeleb numbers are
around 1% EER, and real same-speaker cosines usually sit in the 0.5-0.8 range
rather than at 0.96.

So this spike proves **the loop works**: enroll, embed, score, decide, reject an
unknown. It does not establish that 0.70 is the right threshold, or what the
accuracy will be on the Pi's USB mic. Those need real recordings.

Also worth noting: `kathy` scored 0.451 against `fred`, and both are en_US
voices. That is the highest different-speaker score in the set, and it is the
shape of the problem you should expect from real similar-sounding speakers.

## Shrinking the model for in-daemon use (`shrink_bench.py`)

The HF ONNX export is 24.9 MB. All of it is dense conv/gemm weight — the export
is already embedding-only (`feats [B,T,80]` -> `embs [B,192]`, no 192x17982
classifier head), and only 0.17 MB is foldable BatchNorm/bias. So there is
nothing structural to strip without retraining. The lever is precision:

| variant | size | cosine vs torch | worst same | best diff | separation | ms/clip |
|---|---|---|---|---|---|---|
| torch fp32 | 38.7 MB | 1.0000 | 0.960 | 0.451 | +0.509 | - |
| onnx fp32  | 24.9 MB | 1.0000 | 0.960 | 0.451 | +0.509 | 18.6 |
| onnx int8  | **6.4 MB** | 0.9834 | 0.950 | 0.474 | +0.476 | 28.2 |

INT8 dynamic quantization gives a **3.9x reduction for 0.033 of separation** on
this data. (It is slower, not faster — dynamic quant adds per-run overhead on
CPU. At 28 ms/clip that is irrelevant here.)

Caveat: measured on synthetic voices where the gap is enormous. Losing 0.033
is noise at +0.509; it would matter proportionally more on real speakers whose
gap is already tight. Re-measure on real clips before committing to int8.

fp16 is available behind `WANT_FP16=1` but is a worse deal (~12.4 MB), and the
converter needs an op blocklist to get past a `Cast` node in the pooling
subgraph.

### The parity test earned its keep immediately

The first run of this benchmark showed onnx-fp32 at 0.918 fidelity and
separation collapsing to +0.317 — for a graph that should be numerically
identical to torch. Cause: the feature code rescaled audio to int16 range,
because wespeaker asks torchaudio for `normalize=False`. torchaudio 2.x serves
loads through TorchCodec, which **always** returns normalized float32 and
ignores that flag. Feeding normalized audio takes fidelity to exactly 1.000000.

That is the whole argument for keeping a numeric parity check against the Python
reference: the bug produced no error, no warning, and a model that still
"worked" — just measurably worse.

## Results on real voices (2026-08-28)

Measured through the shipped implementation rather than this script: Electron
dev app, laptop mic, two enrolled profiles (a human and a TTS assistant voice).
**These are the numbers to plan with.**

| check | self | other | note |
|---|---|---|---|
| TTS voice | 0.863 | 0.110 | easiest case: same synthesizer *and* same speaker→mic channel |
| Human, at the mic | 0.784 | 0.110 | true cross-session self-match, different utterance |
| Human, further away | **0.73** | — | distance alone cost 0.054 |

Both directions rank correctly and rejections are decisive, so the model
discriminates rather than just scoring everything high.

**0.70 is not a shippable threshold.** Real self-match headroom over it was
0.084 under favourable conditions, and simply standing further from the mic
consumed 65% of that. Noise, a tired voice, and off-axis speech each cost more.
Falling under the line means the agent says "I don't know who you are" to
someone obviously recognizable, which for a presence layer is a worse failure
than an occasional wrong guess.

Note how much rosier the synthetic table above reads (0.96 self, +0.509
separation) than any of this. That gap is the whole reason to distrust TTS
benchmarks for this task.

## Next steps

1. **Two real humans**, same gender/accent/mic. This is the measurement that
   actually sets the threshold and it has not been taken. A TTS voice scores
   0.11 against a human profile and is not a plausible confuser, so nothing
   above constrains the cutoff.
2. Re-run on the Pi's USB mic, since channel and room change the embedding.
3. Only then pick a threshold, from the real same/different distributions.
4. Enrollment currently averages 2 clips in the UI; the store accepts any
   number. More clips averages away single-session room/mic/mood bias and is
   the cheapest available lift on that 0.784.

## Notes on the dependency stack

`wespeaker_compat.py` exists because wespeaker's model registry unconditionally
imports `s3prl` for its self-supervised frontend, and s3prl 0.4.x still calls
torchaudio APIs removed in torchaudio 2.x (`set_audio_backend`,
`torchaudio.sox_effects`). ECAPA-TDNN takes plain fbank features and never
touches that frontend, so the shim stubs `s3prl` out before wespeaker imports.

Two other things that are not in the WeSpeaker README:

- `load_model('english')` resolves to **voxceleb_resnet221_LM** from ModelScope,
  not ECAPA. `load_model` takes a Hub key or a *local directory*; it has no
  notion of a HuggingFace repo id, so `speakerid.py` fetches the HF repo itself
  and hands over the resulting directory.
- torchaudio 2.13 routes `torchaudio.load` through TorchCodec, so `torchcodec`
  is a hard requirement even though nothing declares it.

## Out of scope

pyannote diarization, openWakeWord, streaming inference, score smoothing,
contacts integration, and any Flux/voice-pipeline wiring. Separate spikes.
