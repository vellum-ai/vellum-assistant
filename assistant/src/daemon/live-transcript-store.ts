/**
 * Rolling buffer for live audio transcript segments.
 *
 * Stores finalized transcript text from the client's system audio
 * capture, bounded to a configurable time window (default 10 minutes).
 * The agent loop reads this buffer to inject transcript context into
 * the system prompt when the user is actively listening to system audio.
 */

import { getLogger } from '../util/logger.js';

const log = getLogger('live-transcript-store');

export interface TranscriptSegment {
  text: string;
  timestamp: number;
}

/** Rolling buffer duration in milliseconds (10 minutes). */
const BUFFER_DURATION_MS = 10 * 60 * 1000;

/** Maximum number of segments to retain (safety cap). */
const MAX_SEGMENTS = 5000;

let segments: TranscriptSegment[] = [];
let listening = false;

/** Record that live listening has started. Clears any stale segments from previous sessions. */
export function startLiveTranscript(): void {
  segments = [];
  listening = true;
  log.info('Live transcript listening started');
}

/** Record that live listening has stopped. Retains buffered segments. */
export function stopLiveTranscript(): void {
  listening = false;
  log.info({ segmentCount: segments.length }, 'Live transcript listening stopped');
}

/** Whether the client is actively listening to system audio. */
export function isLiveTranscriptActive(): boolean {
  return listening;
}

/** Append a transcript segment to the rolling buffer. */
export function appendTranscriptSegment(text: string, timestamp: number): void {
  const trimmed = text.trim();
  if (!trimmed) return;

  segments.push({ text: trimmed, timestamp });

  // Cap segment count
  if (segments.length > MAX_SEGMENTS) {
    segments = segments.slice(segments.length - MAX_SEGMENTS);
  }

  pruneOldSegments();
}

/** Remove segments older than the buffer duration. */
function pruneOldSegments(): void {
  const cutoff = Date.now() - BUFFER_DURATION_MS;
  const before = segments.length;
  segments = segments.filter(s => s.timestamp >= cutoff);
  const pruned = before - segments.length;
  if (pruned > 0) {
    log.debug({ pruned }, 'Pruned old transcript segments');
  }
}

/**
 * Get the current rolling transcript text.
 *
 * Returns null when there is no transcript data (either no segments
 * or listening is not active). The agent loop should only inject
 * transcript context when this returns a non-null value.
 */
export function getLiveTranscriptText(): string | null {
  if (!listening) return null;

  pruneOldSegments();

  if (segments.length === 0) return null;

  return segments.map(s => s.text).join(' ');
}

/** Clear all buffered segments. Primarily for testing. */
export function clearLiveTranscript(): void {
  segments = [];
  listening = false;
}
