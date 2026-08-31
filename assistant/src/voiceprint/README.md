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

The download is pinned to an immutable HuggingFace revision
(`a2f3dcb1c8702caccc7a55ceb57f5e8d1842112b`) and its sha256 is verified before
the file is cached; a cache that fails verification is discarded and refetched.
This is not ceremony. Loading different weights does not throw: the model still
returns a well-formed 192-dim vector, so an unpinned swap would silently score
every existing enrollment against embeddings it cannot be compared to. The
pinned digest is the artifact every measurement below was taken against.

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
match. Measured on real hardware (laptop mic, Electron dev app), with two
humans enrolled separately from their own clips:

| condition                       | cosine      |
| ------------------------------- | ----------- |
| same human, at the mic          | 0.766-0.784 |
| same human, further away        | 0.73        |
| **second human, same mic**      | **0.144**   |
| TTS voice                       | 0.064-0.11  |

The second human is the row that settles it, and it settles it in the
opposite direction to the one originally feared. A real person scores 0.144
against another person's profile, barely above a TTS voice at 0.064. Speaker
confusion is not the constraint.

What is the constraint is the genuine speaker's own variability. The gap runs
from 0.73 (worst genuine) down to 0.144 (best impostor), and every realistic
degradation — distance, a worse mic, background noise, a cold — moves a
genuine score DOWN rather than an impostor's up. A 0.70 cutoff sat 0.03 under
the worst genuine observation and 0.586 over the best impostor: calibrated
against a risk that does not exist, one bad room away from rejecting the
enrolled speaker.

Hence **0.50**. The equal-margin midpoint of the measured gap is 0.437, so
0.50 is already biased toward rejecting impostors while keeping ~0.23 of room
under the worst genuine score. The asymmetry is deliberate: a voiceprint is
context and never an access decision, so a false accept mislabels a speaker
while a false reject makes the feature look broken.

Two speakers is still a thin sample. The open question is a same-gender,
same-accent confuser, which has not been measured; given the size of the gap
it would have to be extraordinary to threaten 0.50, but it is the row worth
adding next. Also unmeasured: the second speaker's own same-speaker score,
and the reverse direction against their profile.

Enrolling from more than one clip is the cheapest accuracy win available:
the store averages any number of clips, and averaging removes room, mic and
mood variation that a single clip bakes in.

## Regenerating the parity fixtures

`__tests__/fixtures/make-fixtures.py` regenerates the golden vectors. It
needs a local Python environment with torch and torchaudio; that environment
is a development tool only. **The runtime is pure TypeScript and never
shells out to Python.**
