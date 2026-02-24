---
name: "Media Processing"
description: "Ingest and process media files (video, audio, image) through a 3-phase pipeline: preprocess, map (Gemini), and reduce (Claude)"
metadata: {"vellum": {"emoji": "🎬"}}
---

Ingest and track processing of media files (video, audio, images) through a configurable 3-phase pipeline.

## End-to-End Workflow

The processing pipeline follows a sequential 3-phase flow:

1. **Ingest** (`ingest_media`) — Register a media file, detect MIME type, extract duration, deduplicate by content hash.
2. **Preprocess** (`extract_keyframes`) — Detect dead time, segment the video into windows, extract downscaled keyframes, build a subject registry, and write a pipeline manifest.
3. **Map** (`analyze_keyframes`) — Send each segment's frames to Gemini 2.5 Flash with assistant-provided extraction instructions and a JSON Schema for guaranteed structured output. Supports concurrency pooling, cost tracking, resumability, and automatic retries.
4. **Reduce / Query** (`query_media`) — Send all map output to Claude for intelligent analysis and Q&A. Supports arbitrary natural language queries about video content.
5. **Clip** (`generate_clip`) — Extract video clips around specific moments.

The processing pipeline service (`services/processing-pipeline.ts`) orchestrates phases 2-4 automatically with retries, resumability, and cancellation support.

## Tools

### ingest_media

Register a media file for processing. Accepts an absolute file path, validates the file exists, detects MIME type, extracts duration (for video/audio via ffprobe), and registers the asset with content-hash deduplication.

### media_status

Query the processing status of a media asset. Returns the asset metadata along with per-stage progress details. Use this to monitor pipeline progress.

### extract_keyframes

Preprocess a video asset: detect dead time via mpdecimate, segment the video into windows, extract downscaled keyframes at regular intervals, build a subject registry, and write a pipeline manifest.

Parameters:
- `asset_id` (required) — ID of the media asset.
- `interval_seconds` — Interval between keyframes (default: 3s).
- `segment_duration` — Duration of each segment window (default: 20s).
- `dead_time_threshold` — Sensitivity for dead-time detection (default: 0.02).
- `section_config` — Path to a JSON file with manual section boundaries.
- `skip_dead_time` — Whether to detect and skip dead time (default: true).
- `short_edge` — Short edge resolution for downscaled frames in pixels (default: 480).

### analyze_keyframes

Map video segments through Gemini's structured output API. Reads frames from the preprocess manifest, sends each segment to Gemini with assistant-provided extraction instructions and a JSON Schema for guaranteed structured output. Supports concurrency pooling, cost tracking, resumability (skips segments with existing results), and automatic retries with exponential backoff.

Parameters:
- `asset_id` (required) — ID of the media asset.
- `system_prompt` (required) — Extraction instructions for Gemini.
- `output_schema` (required) — JSON Schema for structured output.
- `context` — Additional context to include in the prompt.
- `model` — Gemini model to use (default: `gemini-2.5-flash`).
- `concurrency` — Maximum concurrent API requests (default: 10).
- `max_retries` — Retry attempts per segment on failure (default: 3).

### query_media

Query video analysis data using natural language. Sends map output (from analyze_keyframes) to Claude for intelligent analysis and Q&A. Supports arbitrary questions about video content.

Parameters:
- `asset_id` (required) — ID of the media asset.
- `query` (required) — Natural language query about the video data.
- `system_prompt` — Optional system prompt for Claude.
- `model` — LLM model to use (default: `claude-sonnet-4-6`).

### generate_clip

Extract a video clip from a media asset using ffmpeg. Applies configurable pre/post-roll padding (clamped to file boundaries), outputs the clip as a temporary file.

### media_diagnostics

Get a diagnostic report for a media asset. Returns:
- **Processing stats**: total keyframes extracted.
- **Per-stage status and timing**: which stages (preprocess, map, reduce) have run, how long each took, current progress.
- **Failure reasons**: last error from any failed stage.
- **Cost estimation**: based on segment count and Gemini 2.5 Flash pricing, plus a note about Claude reduce costs.

## Services

### Processing Pipeline (services/processing-pipeline.ts)

Orchestrates the full processing pipeline with reliability features:
- **Sequential execution**: preprocess, map, reduce.
- **Retries**: Each stage is retried with exponential backoff and jitter (configurable max retries and base delay).
- **Resumability**: Checks processing_stages to find the last completed stage and resumes from there. Safe to restart after crashes.
- **Cancellation**: Cooperative cancellation via asset status. Set asset status to `cancelled` and the pipeline stops between stages.
- **Idempotency**: Re-ingesting the same file hash is a no-op. Re-running a fully completed pipeline is also a no-op.
- **Graceful degradation**: If a stage fails mid-batch (e.g., Gemini API errors), partial results are saved. The stage is marked as failed with the error details, and the pipeline stops without losing work.

### Preprocess (services/preprocess.ts)

Handles dead-time detection, video segmentation, keyframe extraction, and subject registry building. Writes a pipeline manifest consumed by the Map phase.

### Gemini Map (services/gemini-map.ts)

Sends video segments to Gemini 2.5 Flash with structured output schemas. Handles concurrency pooling, cost tracking, resumability, and retries.

### Reduce (services/reduce.ts)

Sends Map output to Claude as text for analysis. Two modes:
- **One-shot merge**: assembles all Map results and sends to Claude with a system prompt.
- **Interactive Q&A**: loads existing map output + user query, sends to Claude.

### Concurrency Pool (services/concurrency-pool.ts)

Limits concurrent API calls during the Map phase to avoid rate limiting.

### Cost Tracker (services/cost-tracker.ts)

Tracks estimated API costs during pipeline execution.

## Operator Runbook

### Monitoring Progress

Use `media_status` to check the current state of any asset:
- **registered** — Ingested but not yet processed.
- **processing** — Pipeline is running.
- **indexed** — All stages completed successfully.
- **failed** — A stage failed. Check stage details for the error.

The response includes per-stage progress (0-100%) so you can see exactly where processing stands.

### Diagnosing Failures

Use `media_diagnostics` to get a full diagnostic report:
1. Check the `stages` array for any stage with `status: "failed"`.
2. Read the `lastError` field for that stage to understand what went wrong.
3. Check `durationMs` to see if a stage timed out or ran unusually long.
4. Common failure causes:
   - **preprocess**: ffmpeg not installed, corrupt video file, disk full.
   - **map**: Gemini API key not configured, API rate limits, network errors.
   - **reduce**: No LLM provider configured, no map output exists.

After fixing the root cause, re-run the failed stage. The pipeline is resumable — it picks up from where it left off.

### Cost Expectations

The Map phase (Gemini 2.5 Flash) is the primary cost driver. Cost scales with video duration, keyframe interval, and segment size:

| Video Duration | Interval | Keyframes | Segments (~10 frames each) | Estimated Map Cost |
|----------------|----------|-----------|----------------------------|--------------------|
| 30 min         | 3s       | ~600      | ~60                        | ~$0.06             |
| 60 min         | 3s       | ~1,200    | ~120                       | ~$0.12             |
| 90 min         | 3s       | ~1,800    | ~180                       | ~$0.18             |
| 90 min         | 5s       | ~1,080    | ~108                       | ~$0.11             |

The Reduce phase (Claude) adds a small additional cost per query. The `media_diagnostics` tool provides per-asset cost estimates.

### Known Limitations

- **ffmpeg required**: Keyframe extraction and clip generation require ffmpeg to be installed on the host.
- **Single-file ingestion**: Each `ingest_media` call processes one file. Batch ingestion is not yet supported.
- **Gemini rate limits**: The Map phase uses concurrency pooling (default 10) to stay within API limits. Reduce concurrency if you hit 429 errors.
- **No real-time processing**: The pipeline processes pre-recorded media files. Live/streaming video is not supported.

### Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| "No keyframes found" | extract_keyframes not run or failed | Check preprocess stage status; re-run if needed |
| "No map output found" | analyze_keyframes not run | Run analyze_keyframes with appropriate system_prompt and output_schema |
| "No LLM provider available" | API key not configured | Add one in Settings |
| Map phase slow | Large video, small interval | Increase interval_seconds or reduce concurrency |
| Gemini returns errors | Rate limits or schema issues | Check max_retries setting; simplify output_schema if needed |
| Pipeline stuck at "processing" | Stage crashed without updating status | Use `media_diagnostics` to find the stuck stage; re-run manually |

## Usage Notes

- The `ingest_media` tool requires an absolute path to a local file.
- Supported media types: video (mp4, mov, avi, mkv, webm, etc.), audio (mp3, wav, m4a, etc.), and images (png, jpg, gif, webp, etc.).
- For video and audio files, duration is automatically extracted via ffprobe (requires ffmpeg to be installed).
- Duplicate files are detected by content hash and return the existing asset record.
- The `analyze_keyframes` tool is marked as medium risk because it makes external API calls to Gemini, which incur costs.
- All schema tables, services, and tool interfaces are media-generic. Domain-specific interpretation belongs in the system_prompt and output_schema parameters.
