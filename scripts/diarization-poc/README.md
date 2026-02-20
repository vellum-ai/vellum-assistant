# Independent Diarization Pipeline

Standalone scripts for speech chunking, provider diarization, and persistent speaker identity learning.

## Design Goals

- Lean on API provider for speaker diarization (`gpt-4o-transcribe-diarize`)
- Keep speaker labels anonymous by default (`Person 001`, `Person 002`, ...)
- Promote to real names only after repeated evidence
- Run continuously from local mic with low operational complexity

## Install

```bash
cd scripts/diarization-poc
uv sync
```

Set key:

```bash
export OPENAI_API_KEY=...
```

## Run (Recommended)

Terminal 1: capture local mic into VAD chunks

```bash
uv run python capture_vad_chunks.py \
  --out-dir out/chunks \
  --silence-ms 2500 \
  --vad-mode 2
```

Terminal 2: continuous transcription + learning

```bash
uv run python run_pipeline.py \
  --chunks-dir out/chunks \
  --transcripts-dir out/transcripts \
  --labeled-dir out/labeled \
  --registry out/speaker_registry.json \
  --model gpt-4o-transcribe-diarize \
  --identity-model gpt-4o-mini
```

## Output Files

- `out/chunks/*.wav`: audio chunks from VAD
- `out/transcripts/*.json`: raw provider response
- `out/transcripts/*.segments.json`: normalized diarized segments
- `out/transcripts/identity-evidence/*.identity.json`: provider-derived identity evidence
- `out/labeled/*.labeled.json`: segments with global speaker mapping
- `out/speaker_registry.json`: persistent anonymous/named speaker profiles
- `out/pipeline_state.json`: checkpoint of already-processed chunks

## Identity Learning Rules

- New voiceprints start as anonymous profiles (`anon-001` => `Person 001`)
- Segment embeddings are matched to profile centroids
- Identity evidence is extracted by an OpenAI model from transcript context
- Evidence types include `self`, `addressing`, `third_party`, `uncertain`
- `addressing` contributes directly to identifying the addressed speaker
- A profile is promoted to named only after:
  - minimum weighted score (`--min-name-score`)
  - minimum margin over second-best name (`--min-name-margin`)
  - minimum confidence (`--min-name-confidence`)
  - sufficient direct basis (`self + addressing`)

## Tuning For Better Accuracy

- Increase chunk duration quality:
  - `--silence-ms 2800-3500`
  - keep `--frame-ms 30`
- Reduce false splits:
  - lower VAD aggressiveness (`--vad-mode 1`)
- Improve cross-chunk matching:
  - raise `--min-segment-s` to `1.2-1.5`
  - tune `--similarity-threshold` around `0.70-0.78`
