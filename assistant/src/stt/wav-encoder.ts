/**
 * Shared PCM16LE-to-WAV utility for STT streaming adapters.
 *
 * Wraps raw PCM16LE audio bytes in a valid 44-byte RIFF/WAVE header so that
 * STT providers that require WAV input (e.g. OpenAI Whisper) can consume
 * audio captured from streaming sessions.
 *
 * This helper is intentionally decoupled from any specific provider adapter
 * so it can be reused across batch and streaming transcription paths.
 */

// ---------------------------------------------------------------------------
// Format options
// ---------------------------------------------------------------------------

/**
 * Audio format parameters for the PCM-to-WAV encoder.
 *
 * Adapters pass the hardware sample rate captured during the streaming
 * handshake so the WAV header accurately describes the audio data.
 */
export interface WavFormatOptions {
  /** Sample rate in Hz (e.g. 16000, 44100, 48000). Must be positive. */
  sampleRate: number;
  /** Number of audio channels (1 = mono, 2 = stereo). Must be positive. */
  channels: number;
  /**
   * Bits per sample. Defaults to 16 (PCM16LE).
   *
   * Only 8, 16, 24, and 32 are supported — these are the standard PCM bit
   * depths that fit evenly into whole bytes.
   */
  bitsPerSample?: number;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SUPPORTED_BIT_DEPTHS = new Set([8, 16, 24, 32]);

/**
 * Validate format options and throw descriptive errors for invalid
 * configurations. Called internally before encoding.
 */
function validateFormatOptions(options: WavFormatOptions): void {
  const { sampleRate, channels, bitsPerSample = 16 } = options;

  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(
      `Invalid sampleRate: ${sampleRate}. Must be a positive finite number.`,
    );
  }

  if (
    !Number.isFinite(channels) ||
    channels <= 0 ||
    !Number.isInteger(channels)
  ) {
    throw new Error(
      `Invalid channels: ${channels}. Must be a positive integer.`,
    );
  }

  if (!SUPPORTED_BIT_DEPTHS.has(bitsPerSample)) {
    throw new Error(
      `Unsupported bitsPerSample: ${bitsPerSample}. ` +
        `Supported values: ${[...SUPPORTED_BIT_DEPTHS].join(", ")}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// WAV header constants
// ---------------------------------------------------------------------------

/** Total size of the RIFF/WAVE header for PCM data. */
const WAV_HEADER_SIZE = 44;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Wrap raw PCM audio bytes in a valid 44-byte RIFF/WAVE header.
 *
 * @param pcmData - Raw PCM audio data (e.g. PCM16LE samples).
 * @param options - Audio format options describing the PCM data.
 * @returns A `Buffer` containing a complete WAV file (header + PCM payload).
 *
 * @example
 * ```ts
 * const wav = encodePcm16LeToWav(rawPcmBuffer, {
 *   sampleRate: 16000,
 *   channels: 1,
 * });
 * ```
 */
export function encodePcm16LeToWav(
  pcmData: Buffer,
  options: WavFormatOptions,
): Buffer {
  validateFormatOptions(options);

  const { sampleRate, channels, bitsPerSample = 16 } = options;

  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcmData.length;
  const fileSize = WAV_HEADER_SIZE + dataSize;

  const buffer = Buffer.alloc(fileSize);
  let offset = 0;

  // ---- RIFF chunk descriptor ----
  // ChunkID: "RIFF"
  buffer.write("RIFF", offset, "ascii");
  offset += 4;

  // ChunkSize: file size minus 8 bytes (RIFF header)
  buffer.writeUInt32LE(fileSize - 8, offset);
  offset += 4;

  // Format: "WAVE"
  buffer.write("WAVE", offset, "ascii");
  offset += 4;

  // ---- fmt sub-chunk ----
  // Subchunk1ID: "fmt "
  buffer.write("fmt ", offset, "ascii");
  offset += 4;

  // Subchunk1Size: 16 for PCM
  buffer.writeUInt32LE(16, offset);
  offset += 4;

  // AudioFormat: 1 = PCM (uncompressed)
  buffer.writeUInt16LE(1, offset);
  offset += 2;

  // NumChannels
  buffer.writeUInt16LE(channels, offset);
  offset += 2;

  // SampleRate
  buffer.writeUInt32LE(sampleRate, offset);
  offset += 4;

  // ByteRate = SampleRate * NumChannels * BitsPerSample / 8
  buffer.writeUInt32LE(byteRate, offset);
  offset += 4;

  // BlockAlign = NumChannels * BitsPerSample / 8
  buffer.writeUInt16LE(blockAlign, offset);
  offset += 2;

  // BitsPerSample
  buffer.writeUInt16LE(bitsPerSample, offset);
  offset += 2;

  // ---- data sub-chunk ----
  // Subchunk2ID: "data"
  buffer.write("data", offset, "ascii");
  offset += 4;

  // Subchunk2Size: size of the raw audio data
  buffer.writeUInt32LE(dataSize, offset);
  offset += 4;

  // ---- PCM payload ----
  pcmData.copy(buffer, offset);

  return buffer;
}
