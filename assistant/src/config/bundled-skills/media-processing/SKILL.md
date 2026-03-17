---
name: media-processing
description: "Ingest and process media files (video, audio, image)"
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🎬"
  vellum:
    display-name: "Media Processing"
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
- `interval_seconds` — Interval between keyframes (default: 1s). Use 0.5s for sports/action content where frame density matters.
- `segment_duration` — Duration of each segment window (default: 15s).
- `dead_time_threshold` — Sensitivity for dead-time detection (default: 0.02).
- `section_config` — Path to a JSON file with manual section boundaries.
- `detect_dead_time` — Whether to detect and skip dead time (default: false). Dead-time detection can be too aggressive for continuous action video like sports — it may incorrectly skip live play. Enable only for content with clear idle periods (e.g., lectures, surveillance footage).
- `short_edge` — Short edge resolution for downscaled frames in pixels (default: 480).
- `include_audio` — Whether to extract and transcribe audio for each segment (default: false). When enabled, each segment's audio is transcribed and stored alongside visual frames.
- `transcription_mode` — Transcription backend: `'api'` (OpenAI Whisper cloud) or `'local'` (whisper.cpp on-device). Default: `'local'`. The `'api'` mode requires an OpenAI API key configured in settings.

### analyze_keyframes

Map video segments through Gemini's structured output API. Supports two modes:

- **`keyframes`** (default) — Reads frames from the preprocess manifest, sends each segment's images to Gemini. Requires `extract_keyframes` to be run first. Best for longer videos (> 1 hour) or when you need fine-grained control over frame selection (interval, segment duration, dead-time skipping).
- **`direct_video`** — Uploads the video file directly to Gemini's Files API. Gemini sees actual motion and temporal context instead of static frames. Best for shorter videos (< 1 hour) where temporal context matters (detecting actions, transitions, motion patterns). Has a 2 GB file size limit. Does not require `extract_keyframes` preprocessing.

Both modes produce the same `MapOutput` format, so `query_media` works identically regardless of which mode was used.

Parameters:

- `asset_id` (required) — ID of the media asset.
- `system_prompt` (required) — Extraction instructions for Gemini.
- `output_schema` (required) — JSON Schema for structured output.
- `mode` — Analysis mode: `'keyframes'` (default) or `'direct_video'`.
- `context` — Additional context to include in the prompt.
- `model` — Gemini model to use (default: `gemini-2.5-flash`).
- `concurrency` — Maximum concurrent API requests (default: 10, keyframes mode only).
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

## Audio + Vision Multimodal Analysis

When `include_audio` is enabled on `extract_keyframes`, the pipeline transcribes each segment's audio track and attaches the transcript to the segment data. During the Map phase (`analyze_keyframes`), Gemini receives both the visual frames and the audio transcript for each segment, enabling multimodal analysis that combines what is seen with what is said.

This is useful for:

- **Lectures and presentations**: Correlate slide content (visual) with speaker narration (audio).
- **Sports broadcasts**: Combine on-screen action with commentary for richer event detection.
- **Meetings and interviews**: Pair facial expressions and gestures with spoken dialogue.
- **Tutorials and demos**: Link on-screen actions with verbal instructions.

Transcription modes:

- **`local`** (default): Uses whisper.cpp for on-device transcription. Requires `whisper-cpp` to be installed (`brew install whisper-cpp`). No API costs, but slower.
- **`api`**: Uses the OpenAI Whisper API for cloud-based transcription. Faster and more accurate, but requires an OpenAI API key and incurs per-minute costs.

The audio transcription degrades gracefully — if transcription fails for a segment (missing tools, no audio track, API errors), the segment proceeds with visual-only analysis.

## Best Practices

### Map Prompt Strategy: Go Broad, Not Targeted

The single most important insight: **always use a broad, descriptive map prompt** instead of a targeted one.

A targeted prompt like "find turnovers" locks you into one topic. If the user later wants to ask about defense, formations, or specific players, you'd need to reprocess the entire video. Instead, run a general-purpose descriptive prompt that captures everything visible, creating a rich, reusable dataset. Then all follow-up questions can be handled via `query_media` with no reprocessing.

**One map run, many queries.**

The map output will be larger (more tokens per segment), but Gemini Flash is cheap enough that this is a good tradeoff. Only use a targeted prompt if the user explicitly asks for something narrow.

#### Sample General-Purpose Map Prompt

Use this as a starting point for the `system_prompt` parameter in `analyze_keyframes`:

```
You are analyzing keyframes from a video. For each segment, describe everything you can observe:

- People visible: count, positions, identifying features (jersey numbers, clothing, names if visible)
- Actions and movements: what people are doing, direction of movement, interactions
- Objects of interest: ball location, equipment, vehicles, on-screen graphics
- Environment: setting, lighting, weather if outdoors
- Text on screen: scores, captions, titles, signs, timestamps
- Scene composition: camera angle, zoom level, any transitions between shots
- Any stoppages, pauses, or changes in activity

Be specific and factual. Describe what you see, not what you infer happened between frames.
```

#### Sample Output Schema

```json
{
  "type": "object",
  "properties": {
    "scene_description": { "type": "string" },
    "people": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "description": { "type": "string" },
          "position": { "type": "string" },
          "action": { "type": "string" }
        }
      }
    },
    "objects_of_interest": { "type": "array", "items": { "type": "string" } },
    "on_screen_text": { "type": "array", "items": { "type": "string" } },
    "camera": { "type": "string" },
    "notable_events": { "type": "array", "items": { "type": "string" } }
  }
}
```

### Clip Delivery

The `generate_clip` tool automatically opens clips in the user's default video player after extraction (handled internally — do **not** run `open` via `host_bash`). Clips are saved persistently in the asset's pipeline directory (`pipeline/<assetId>/clips/`), falling back to a temp directory when the source location is read-only. Each clip gets a unique filename so concurrent or repeated extractions at the same range never collide. The `clipPath` field in the tool response contains the absolute file path.

The tool handles high-bitrate and incompatible codec sources automatically — it tries stream copy first for speed, then falls back to H.264 re-encoding if needed. **Always use `generate_clip` rather than manual ffmpeg commands.**

Always provide a descriptive `title` parameter (e.g. `"snow-dive-closeup"`, `"goal-celebration"`) so clips get meaningful filenames instead of timestamp-based names.

## Known Limitations — Vision Analysis

Gemini performs well at **spatial/descriptive analysis** from static keyframes:

- Player positions, formations, and spacing
- Jersey numbers and identifying features
- Ball location and which team has possession
- Score and on-screen text
- Camera angles and scene composition

Gemini **hallucinates when asked to detect fast temporal events** from static frames (keyframes mode), regardless of frame density:

- Turnovers, steals, fouls, and specific plays
- Fast transitions and split-second actions
- Causality between frames (what "happened" vs. what's visible)

The model is good at describing **what is there** but bad at detecting **what happened** from static frames. For content where temporal context matters, consider using `mode: 'direct_video'` which lets Gemini see actual motion. For keyframes mode, structure your map prompts and queries accordingly — ask the model to describe scenes, then use `query_media` (Claude) to reason about patterns and events across the descriptive data.

## Operator Runbook

### Monitoring Progress

Use `media_status` to check the current state of any asset:

- **registered** — Ingested but not yet processed.
- **processing** — Pipeline is running.
- **indexed** — All stages completed successfully.
- **failed** — A stage failed. Check stage details for the error.

The response includes per-stage progress (0-100%) so you can see exactly where processing stands.

### Diagnosing Failures

Use `media_status` to check processing stages:

1. Check the `stages` array for any stage with `status: "failed"`.
2. Read the `lastError` field for that stage to understand what went wrong.
3. Check `durationMs` to see if a stage timed out or ran unusually long.
4. Common failure causes:
   - **preprocess**: ffmpeg not installed, corrupt video file, disk full.
   - **map**: Gemini API key not configured, API rate limits, network errors.
   - **reduce**: No LLM provider configured, no map output exists.

After fixing the root cause, re-run the failed stage. The pipeline is resumable — it picks up from where it left off.

### Cost Expectations

The Map phase (Gemini) is the primary cost driver — it scales with video duration and keyframe interval. The Q&A phase (Claude) is negligible per query.

### Known Limitations

- **ffmpeg required**: Keyframe extraction and clip generation require ffmpeg to be installed on the host.
- **Single-file ingestion**: Each `ingest_media` call processes one file. Batch ingestion is not yet supported.
- **Gemini rate limits**: The Map phase uses concurrency pooling (default 10) to stay within API limits. Reduce concurrency if you hit 429 errors.
- **No real-time processing**: The pipeline processes pre-recorded media files. Live/streaming video is not supported.

### Troubleshooting

| Symptom                        | Likely Cause                          | Fix                                                                    |
| ------------------------------ | ------------------------------------- | ---------------------------------------------------------------------- |
| "No keyframes found"           | extract_keyframes not run or failed   | Check preprocess stage status; re-run if needed                        |
| "No map output found"          | analyze_keyframes not run             | Run analyze_keyframes with appropriate system_prompt and output_schema |
| "No LLM provider available"    | API key not configured                | Add one in Settings                                                    |
| Map phase slow                 | Large video, small interval           | Increase interval_seconds or reduce concurrency                        |
| Gemini returns errors          | Rate limits or schema issues          | Check max_retries setting; simplify output_schema if needed            |
| Pipeline stuck at "processing" | Stage crashed without updating status | Use `media_status` to check stage progress; re-run manually            |

## Usage Notes

- The `ingest_media` tool requires an absolute path to a local file.
- Supported media types: video (mp4, mov, avi, mkv, webm, etc.), audio (mp3, wav, m4a, etc.), and images (png, jpg, gif, webp, etc.).
- For video and audio files, duration is automatically extracted via ffprobe (requires ffmpeg to be installed).
- Duplicate files are detected by content hash and return the existing asset record.
- The `analyze_keyframes` tool is marked as medium risk because it makes external API calls to Gemini, which incur costs.
- All schema tables, services, and tool interfaces are media-generic. Domain-specific interpretation belongs in the system_prompt and output_schema parameters.
