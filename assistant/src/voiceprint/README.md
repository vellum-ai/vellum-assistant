# Voiceprints

Speaker identification for contacts: given a clip of speech, say which
enrolled contact it probably is.

## This identifies, it does not authenticate

A voiceprint is contact **context, not a credential**. It answers "who is
probably in the room", and it must never gate access to anything.

That constraint is structural, not stylistic. Voiceprints live in the
assistant database only — never in the gateway ACL or `contact_channels`.
`contact_channels` is exact-match and anchored by an external authority; a
voice is neither, and once copied it cannot be rotated. Anything genuinely
gated must still check the real credential.

The same care applies to prompt injection: an identity hint handed to the
model is a soft path back to the boundary the schema deliberately excludes.
Any such hint must carry its own uncertainty and an explicit "not
authentication" framing.

## Model

`Wespeaker/wespeaker-ecapa-tdnn512-LM` — ECAPA-TDNN, 192-dim output over
80-bin Kaldi fbank features, MIT licensed, opset 14. It runs fully on
device; nothing about a voice leaves the machine.

Embeddings from different models are not comparable, so `model_id` is stored
on every row and checked before scoring.

The weights (24.9 MB fp32) are fetched on first use into
`<workspace>/data/models/` — see `resolveModelPath()`. A 6.4 MB int8
quantization exists and is 3.9x smaller at a cost of 0.033 separation;
switching is isolated to that one function.

## Why inference runs in a separate process

`onnxruntime-node` cannot be bundled into the daemon. `bun --compile` embeds
the 266 KB `.node` addon but not the 44 MB `libonnxruntime` dylib it links
against, so the addon fails to `dlopen`; marking it external does not help
either, because a compiled binary cannot resolve bare specifiers from
`/$bunfs/root`. A top-level import therefore kills the packaged assistant at
startup, not just this feature.

So the forward pass runs in a standalone bun process against the ONNX
runtime that `EmbeddingRuntimeManager` already downloads on every daemon
start — no second copy, and no version bump that would force existing
installs to re-download. That runtime pins **1.21.0**; this model loads on it
unchanged, and 1.21 and 1.29 agree to cosine 1.00000000 (max elementwise
delta 1.1e-5).

The fbank front end deliberately stays in the host process. It is pure
TypeScript, and `__tests__/fbank-parity.test.ts` guards it against silent
numeric drift, so only the forward pass crosses the process boundary.

> If you ever bump the shared runtime, note that
> `EmbeddingRuntimeManager`'s strip step is hardcoded to `bin/napi-v3`
> (1.21's layout). Newer ORT uses `napi-v6`, where that strip silently
> no-ops and leaves ~296 MB on disk.

## Thresholds

`DEFAULT_MATCH_THRESHOLD` is the cosine score above which a clip is called a
match. Measured on real hardware (laptop mic, Electron dev app):

| condition                | cosine |
| ------------------------ | ------ |
| same human, at the mic   | 0.784  |
| same human, further away | 0.73   |
| different speaker        | 0.11   |

Distance alone eats most of the headroom above a 0.70 cutoff, so **0.70 is
not a settled number**. The measurement that would settle it — two real
humans of similar voice on the same mic — has not been taken. A TTS voice
scores 0.11 and is not a plausible confuser, so it cannot stand in.

Enrolling from more than one clip is the cheapest accuracy win available:
the store averages any number of clips, and averaging removes room, mic and
mood variation that a single clip bakes in.

## Regenerating the parity fixtures

`__tests__/fixtures/make-fixtures.py` regenerates the golden vectors. It
needs a local Python environment with torch and torchaudio; that environment
is a development tool only. **The runtime is pure TypeScript and never
shells out to Python.**
