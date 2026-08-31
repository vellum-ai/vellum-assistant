/**
 * Minimal WAV reader for the voiceprint front end.
 *
 * Deliberately narrow: it accepts the uncompressed PCM the voice
 * surfaces produce and rejects everything else loudly, rather than
 * guessing and handing the model garbage that would only show up as a
 * quietly worse embedding.
 */

export interface DecodedAudio {
  /** Mono, normalized to roughly [-1, 1]. */
  samples: Float32Array;
  sampleRate: number;
}

export class UnsupportedAudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedAudioError";
  }
}

const FORMAT_PCM = 1;
const FORMAT_IEEE_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

function readFourCC(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/**
 * Decode a PCM WAV buffer to mono float samples.
 *
 * Multi-channel input is averaged down to mono, which is what the
 * speaker model expects.
 */
export function decodeWav(buffer: ArrayBufferLike): DecodedAudio {
  const view = new DataView(buffer as ArrayBuffer);
  if (view.byteLength < 12) {
    throw new UnsupportedAudioError("Buffer is too short to be a WAV file");
  }
  if (readFourCC(view, 0) !== "RIFF" || readFourCC(view, 8) !== "WAVE") {
    throw new UnsupportedAudioError("Not a RIFF/WAVE file");
  }

  let formatTag = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;

  // Walk the chunk list rather than assuming fmt/data sit at fixed
  // offsets; recorders routinely insert LIST and fact chunks.
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = readFourCC(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      formatTag = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
      if (formatTag === FORMAT_EXTENSIBLE && size >= 26) {
        // The real format tag lives at the head of the GUID.
        formatTag = view.getUint16(body + 24, true);
      }
    } else if (id === "data") {
      dataOffset = body;
      dataLength = Math.min(size, view.byteLength - body);
    }
    // Chunks are word-aligned, so odd sizes carry a pad byte.
    offset = body + size + (size % 2);
  }

  if (dataOffset < 0 || channels === 0 || sampleRate === 0) {
    throw new UnsupportedAudioError("WAV file is missing a fmt or data chunk");
  }

  const frames = readFrames(view, {
    formatTag,
    bitsPerSample,
    channels,
    dataOffset,
    dataLength,
  });

  return { samples: frames, sampleRate };
}

function readFrames(
  view: DataView,
  spec: {
    formatTag: number;
    bitsPerSample: number;
    channels: number;
    dataOffset: number;
    dataLength: number;
  },
): Float32Array {
  const { formatTag, bitsPerSample, channels, dataOffset, dataLength } = spec;
  const bytesPerSample = bitsPerSample / 8;
  const totalSamples = Math.floor(dataLength / bytesPerSample);
  const frames = Math.floor(totalSamples / channels);
  const out = new Float32Array(frames);

  const read = sampleReader(view, formatTag, bitsPerSample);

  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += read(dataOffset + (f * channels + c) * bytesPerSample);
    }
    out[f] = sum / channels;
  }
  return out;
}

function sampleReader(
  view: DataView,
  formatTag: number,
  bitsPerSample: number,
): (byteOffset: number) => number {
  if (formatTag === FORMAT_IEEE_FLOAT && bitsPerSample === 32) {
    return (o) => view.getFloat32(o, true);
  }
  if (formatTag === FORMAT_PCM) {
    switch (bitsPerSample) {
      case 16:
        // Divide by 2^15, matching how torchaudio normalizes int16.
        return (o) => view.getInt16(o, true) / 32768;
      case 32:
        return (o) => view.getInt32(o, true) / 2147483648;
      case 8:
        // 8-bit WAV is unsigned with a 128 midpoint.
        return (o) => (view.getUint8(o) - 128) / 128;
      default:
        break;
    }
  }
  throw new UnsupportedAudioError(
    `Unsupported WAV encoding: format ${formatTag}, ${bitsPerSample}-bit. ` +
      "Convert to 16-bit PCM first.",
  );
}
