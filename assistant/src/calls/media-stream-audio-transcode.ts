/**
 * Audio transcoding helpers for media-stream outbound playback.
 *
 * Twilio media streams send and receive audio as base64-encoded mu-law
 * (audio/x-mulaw) at 8 kHz mono. This module provides utilities for:
 *
 * 1. Converting linear PCM audio (from TTS providers) to mu-law encoding.
 * 2. Chunking a contiguous audio buffer into Twilio-compatible frame sizes.
 * 3. Encoding frames as base64 strings ready for the `media` outbound command.
 *
 * The chunk size is aligned to Twilio's expected frame duration (~20 ms at
 * 8 kHz = 160 samples per frame). Larger payloads are split into multiple
 * frames to avoid buffering delays on the Twilio side.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Twilio media streams expect 20 ms frames at 8 kHz mono mu-law.
 * 8000 samples/sec * 0.020 sec = 160 samples per frame.
 * Each mu-law sample is 1 byte, so each frame is 160 bytes.
 */
export const MULAW_FRAME_SIZE = 160;

/**
 * Bias constant used in the linear-to-mu-law compression formula
 * (ITU-T G.711).
 */
const MULAW_BIAS = 0x84;

/** Maximum value for the mu-law compression input. */
const MULAW_CLIP = 32635;

/**
 * Lookup table for the segment number in mu-law encoding.
 * Maps magnitude ranges to segment indices.
 */
const MULAW_SEG_TABLE = [0, 0, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3];

// ---------------------------------------------------------------------------
// Linear PCM to mu-law conversion
// ---------------------------------------------------------------------------

/**
 * Compress a single 16-bit linear PCM sample to 8-bit mu-law.
 *
 * Implements the ITU-T G.711 mu-law encoding algorithm. The input is a
 * signed 16-bit integer (range: -32768 to +32767). The output is an
 * unsigned 8-bit mu-law value.
 */
export function linearToMulaw(sample: number): number {
  // Determine sign and clamp magnitude
  const sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;

  // Determine segment
  const exponent = segmentSearch(sample);
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const mulawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;

  return mulawByte;
}

function segmentSearch(val: number): number {
  let shifted = val >> 7;
  if (shifted >= 16) {
    shifted >>= 4;
    if (shifted >= 16) return 7;
    return MULAW_SEG_TABLE[shifted] + 4;
  }
  return MULAW_SEG_TABLE[shifted];
}

// ---------------------------------------------------------------------------
// PCM buffer to mu-law buffer conversion
// ---------------------------------------------------------------------------

/**
 * Convert a buffer of 16-bit signed little-endian PCM samples to mu-law.
 *
 * @param pcm - Raw PCM audio buffer. Every 2 bytes is one sample (LE).
 * @returns A Buffer of mu-law encoded bytes (half the length of the input).
 */
export function pcm16ToMulaw(pcm: Uint8Array): Buffer {
  const sampleCount = Math.floor(pcm.length / 2);
  const mulaw = Buffer.alloc(sampleCount);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);

  for (let i = 0; i < sampleCount; i++) {
    const sample = view.getInt16(i * 2, true); // little-endian
    mulaw[i] = linearToMulaw(sample);
  }

  return mulaw;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * Split a mu-law audio buffer into base64-encoded frames suitable for
 * Twilio media stream `media` commands.
 *
 * Each frame is {@link MULAW_FRAME_SIZE} bytes (160 bytes = 20 ms at 8 kHz).
 * The final frame may be shorter if the buffer length is not an exact
 * multiple of the frame size.
 *
 * @param mulawBuffer - Contiguous mu-law audio bytes.
 * @returns Array of base64-encoded frame strings.
 */
export function chunkMulawToBase64Frames(mulawBuffer: Buffer): string[] {
  const frames: string[] = [];
  let offset = 0;

  while (offset < mulawBuffer.length) {
    const end = Math.min(offset + MULAW_FRAME_SIZE, mulawBuffer.length);
    const frame = mulawBuffer.subarray(offset, end);
    frames.push(Buffer.from(frame).toString("base64"));
    offset = end;
  }

  return frames;
}

// ---------------------------------------------------------------------------
// High-level: raw audio bytes to sendable base64 frames
// ---------------------------------------------------------------------------

/**
 * Accepted audio formats for transcoding into mu-law frames.
 *
 * Currently only `mulaw` (already in the target format) and `pcm16` (16-bit
 * signed LE PCM at 8 kHz) are supported. Higher-level formats (mp3, wav,
 * opus) require decoding to PCM first -- callers should handle that
 * conversion before invoking this helper.
 */
export type TranscodeInputFormat = "mulaw" | "pcm16";

/**
 * Transcode raw audio bytes into Twilio-compatible base64-encoded mu-law
 * frames.
 *
 * @param audio - Raw audio bytes in the specified format.
 * @param format - The format of the input audio.
 * @returns Array of base64-encoded mu-law frames ready for
 *   `MediaStreamOutput.sendAudioPayload()`.
 */
export function transcodeToMulawFrames(
  audio: Uint8Array,
  format: TranscodeInputFormat,
): string[] {
  let mulawBuffer: Buffer;

  switch (format) {
    case "mulaw":
      mulawBuffer = Buffer.from(audio);
      break;
    case "pcm16":
      mulawBuffer = pcm16ToMulaw(audio);
      break;
    default:
      throw new Error(`Unsupported transcode format: ${format as string}`);
  }

  return chunkMulawToBase64Frames(mulawBuffer);
}
