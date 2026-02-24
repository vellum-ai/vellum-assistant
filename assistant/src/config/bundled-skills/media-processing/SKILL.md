---
name: "Media Processing"
description: "Ingest and process media files (video, audio, image) through multi-stage pipelines including keyframe extraction, vision analysis, and timeline generation"
metadata: {"vellum": {"emoji": "🎬"}}
---

Ingest and track processing of media files (video, audio, images) through configurable multi-stage pipelines.

## End-to-End Workflow

The processing pipeline follows a sequential flow. Each stage depends on the output of the previous one:

1. **Ingest** (`ingest_media`) — Register a media file, detect MIME type, extract duration, deduplicate by content hash.
2. **Extract Keyframes** (`extract_keyframes`) — Pull frames from video at regular intervals (default: every 3 seconds) using ffmpeg.
3. **Analyze Keyframes** (`analyze_keyframes`) — Send each keyframe to Claude VLM for structured scene analysis (subjects, actions, context).
4. **Generate Timeline** — Aggregate vision outputs into coherent timeline segments (called via `services/timeline-service.ts`).
5. **Detect Events** (`detect_events`) — Apply configurable detection rules against timeline segments to find events of interest.
6. **Query & Clip** — Use `query_media_events` to search events with natural language, and `generate_clip` to extract video clips around specific moments.

The processing pipeline service (`services/processing-pipeline.ts`) can orchestrate stages 2-5 automatically with retries, resumability, and cancellation support.

## Tools

### ingest_media

Register a media file for processing. Accepts an absolute file path, validates the file exists, detects MIME type, extracts duration (for video/audio via ffprobe), and registers the asset with content-hash deduplication.

### media_status

Query the processing status of a media asset. Returns the asset metadata along with per-stage progress details. Use this to monitor pipeline progress.

### extract_keyframes

Extract keyframes from a video asset at regular intervals using ffmpeg. Frames are saved as JPEG images and registered in the database for subsequent vision analysis.

### analyze_keyframes

Analyze extracted keyframes using Claude VLM (vision language model). Produces structured JSON output with scene descriptions, subjects, actions, and context. Supports resumability by skipping already-analyzed frames.

### detect_events

Detect events from timeline segments using configurable detection rules. Built-in rule types:
- **segment_transition** — Fires when a specified field changes between adjacent segments.
- **short_segment** — Fires when a segment's duration is below a threshold.
- **attribute_match** — Fires when segment attribute values match a regex pattern.

If no rules are provided, sensible defaults are applied based on the event type.

### query_media_events

Query detected events using natural language. Parses the query into structured filters (event type, count, confidence threshold, time range) and returns matching events ranked by confidence.

### generate_clip

Extract a video clip from a media asset using ffmpeg. Applies configurable pre/post-roll padding (clamped to file boundaries), outputs the clip as a temporary file.

### select_tracking_profile

Configure which event capabilities are enabled for a media asset. Capabilities are organized into tiers:
- **Ready**: Production-quality detection, included by default.
- **Beta**: Functional but may have accuracy gaps. Results include a confidence disclaimer.
- **Experimental**: Early-stage detection, expect noise. Results include a confidence disclaimer.

Call without capabilities to see available options; call with a capabilities array to set the profile.

### submit_feedback

Submit feedback on a detected event. Supports four types:
- **correct** — Confirms the event is accurate.
- **incorrect** — Marks a false positive.
- **boundary_edit** — Adjusts start/end times.
- **missed** — Reports an event the system failed to detect.

### recalibrate

Re-rank existing events based on accumulated feedback. Adjusts confidence scores using correction patterns (false positive rates, missed events, boundary adjustments).

### media_diagnostics

Get a diagnostic report for a media asset. Returns:
- **Processing stats**: total keyframes, vision outputs, timeline segments, events detected.
- **Per-stage status and timing**: which stages have run, how long each took, current progress.
- **Failure reasons**: last error from any failed stage.
- **Cost estimation**: based on keyframe count and estimated API cost per frame.
- **Feedback summary**: precision/recall estimates per event type.

## Services

### Processing Pipeline (services/processing-pipeline.ts)

Orchestrates the full processing pipeline with reliability features:
- **Sequential execution**: keyframe_extraction, vision_analysis, timeline_generation, event_detection.
- **Retries**: Each stage is retried with exponential backoff and jitter (configurable max retries and base delay).
- **Resumability**: Checks processing_stages to find the last completed stage and resumes from there. Safe to restart after crashes.
- **Cancellation**: Cooperative cancellation via asset status. Set asset status to `cancelled` and the pipeline stops between stages.
- **Idempotency**: Re-ingesting the same file hash is a no-op. Re-running a fully completed pipeline is also a no-op.
- **Graceful degradation**: If a stage fails mid-batch (e.g., vision API errors), partial results are saved. The stage is marked as failed with the error details, and the pipeline stops without losing work.

### Timeline Generation (services/timeline-service.ts)

Aggregates vision analysis outputs into coherent timeline segments. Groups adjacent keyframes that share similar scene characteristics into time ranges with merged attributes.

### Event Detection (services/event-detection-service.ts)

Evaluates configurable detection rules against timeline segments. Produces scored event candidates with weighted confidence.

### Feedback Aggregation (services/feedback-aggregation.ts)

Computes precision/recall estimates per event type from user feedback. Provides structured JSON export for offline analysis.

### Capability Registry (services/capability-registry.ts)

Maintains an extensible, domain-agnostic catalog of available tracking capabilities with tier classification. Other domains can register their own capabilities by calling `registerCapability()`.

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
   - **keyframe_extraction**: ffmpeg not installed, corrupt video file, disk full.
   - **vision_analysis**: Anthropic API key not configured (add one in Settings → Integrations), API rate limits, network errors.
   - **timeline_generation**: No keyframes or vision outputs exist (earlier stage skipped or failed).
   - **event_detection**: No timeline segments exist.

After fixing the root cause, re-run the failed stage. The pipeline is resumable — it picks up from where it left off.

### Configuring Tracking Profiles

1. Call `select_tracking_profile` with just the `asset_id` to see available capabilities and their tiers.
2. Call again with a `capabilities` array to enable the desired event types.
3. Only enabled capabilities are returned by `query_media_events`.
4. The capability registry is extensible — new domains can register capabilities via `registerCapability()` in `services/capability-registry.ts`.

### Feedback and Recalibration

1. Review detected events using `query_media_events`.
2. For each event, submit feedback via `submit_feedback`:
   - Mark correct detections as `correct` to build precision data.
   - Mark false positives as `incorrect`.
   - Adjust boundaries with `boundary_edit`.
   - Report missed events with `missed` (creates a new event record).
3. Run `recalibrate` to re-rank events based on accumulated feedback.
4. Use `media_diagnostics` to check precision/recall estimates after feedback.

### Cost Expectations

Vision analysis is the primary cost driver. Cost scales linearly with video duration and keyframe interval:

| Video Duration | Interval | Keyframes | Estimated Cost |
|----------------|----------|-----------|----------------|
| 30 min         | 3s       | ~600      | ~$1.80         |
| 60 min         | 3s       | ~1,200    | ~$3.60         |
| 90 min         | 3s       | ~1,800    | ~$5.40         |
| 90 min         | 5s       | ~1,080    | ~$3.24         |

Increasing the keyframe interval reduces cost proportionally but may miss short-duration events. The `media_diagnostics` tool provides per-asset cost estimates.

### Known Limitations

- **ffmpeg required**: Keyframe extraction and clip generation require ffmpeg to be installed on the host.
- **Single-file ingestion**: Each `ingest_media` call processes one file. Batch ingestion is not yet supported.
- **Vision model latency**: Analyzing keyframes is the slowest stage. A 90-minute video at 3-second intervals requires ~1,800 API calls.
- **Scene similarity heuristic**: Timeline segmentation uses Jaccard similarity on subjects — it works well for distinct scenes but may over-merge visually similar but semantically different moments.
- **Detection rules are heuristic**: Event detection uses rule-based scoring, not ML. Accuracy depends on how well the rules match the target event patterns. Use feedback and recalibration to improve over time.
- **No real-time processing**: The pipeline processes pre-recorded media files. Live/streaming video is not supported.

### Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| "No keyframes found" | extract_keyframes not run or failed | Check keyframe_extraction stage status; re-run if needed |
| "No Anthropic API key available" | API key not configured | Add one in Settings → Integrations |
| Vision analysis very slow | Large video, small interval | Increase interval_seconds or use smaller batch_size |
| Low event confidence | Detection rules too broad | Tune rules: increase weights on high-signal rules, use tighter regex patterns |
| Many false positives | Rules overfitting on noise | Submit `incorrect` feedback, then run `recalibrate` |
| Pipeline stuck at "processing" | Stage crashed without updating status | Use `media_diagnostics` to find the stuck stage; re-run manually |

## Usage Notes

- The `ingest_media` tool requires an absolute path to a local file.
- Supported media types: video (mp4, mov, avi, mkv, webm, etc.), audio (mp3, wav, m4a, etc.), and images (png, jpg, gif, webp, etc.).
- For video and audio files, duration is automatically extracted via ffprobe (requires ffmpeg to be installed).
- Duplicate files are detected by content hash and return the existing asset record.
- The `analyze_keyframes` tool is marked as medium risk because it makes external API calls to Claude VLM, which incur costs.
- All schema tables, services, and tool interfaces are media-generic. Domain-specific interpretation belongs in VLM prompt templates.
