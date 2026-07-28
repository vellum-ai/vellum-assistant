import JSZip from "jszip";

export const VOICE_DEMO_OUTPUT_SAMPLE_RATE = 48_000;

export interface VoiceDemoAudioRoute {
  inputs: Array<Record<string, unknown>>;
  outputs: Array<Record<string, unknown>>;
  sampleRate: number;
  ioBufferDuration: number;
}

export interface VoiceDemoEvent {
  type: string;
  t: number;
  endT?: number;
  id?: string;
  text?: string;
  metadata?: Record<string, unknown>;
}

export interface VoiceDemoSessionDocument {
  sessionId: string;
  startedAt: string;
  durationSeconds: number;
  audioRoute: VoiceDemoAudioRoute;
  files: {
    alex: "alex.wav";
    pax: "pax.wav";
    mix: "mix.wav";
  };
  events: VoiceDemoEvent[];
}

export interface VoiceDemoAudioSegment {
  id: string;
  startT: number;
  endT: number;
  sampleRate: number;
  format: "float32" | "int16";
  channels: ArrayBuffer[];
}

export interface VoiceDemoTranscriptEntry {
  t: number;
  speaker: "ALEX" | "PAX";
  text: string;
}

export interface VoiceDemoFinalizerInput {
  folderName: string;
  session: VoiceDemoSessionDocument;
  alexSegments: VoiceDemoAudioSegment[];
  paxSegments: VoiceDemoAudioSegment[];
  transcriptEntries: VoiceDemoTranscriptEntry[];
}

export interface VoiceDemoFinalizerOutput {
  filename: string;
  zip: ArrayBuffer;
}

export type VoiceDemoFinalizerResult =
  | ({ ok: true } & VoiceDemoFinalizerOutput)
  | { ok: false; message: string };

export async function finalizeVoiceDemoCapture(
  input: VoiceDemoFinalizerInput,
): Promise<VoiceDemoFinalizerOutput> {
  const frameCount = Math.ceil(
    input.session.durationSeconds * VOICE_DEMO_OUTPUT_SAMPLE_RATE,
  );
  const alex = renderMonoTrack(input.alexSegments, frameCount);
  const pax = renderMonoTrack(input.paxSegments, frameCount);

  const zip = new JSZip();
  const folder = zip.folder(input.folderName);
  if (!folder) {
    throw new Error("Failed to create voice demo archive folder");
  }

  folder.file(
    "session.json",
    `${JSON.stringify(input.session, null, 2)}\n`,
  );
  folder.file(
    "alex.wav",
    encodeFloatWav([alex], VOICE_DEMO_OUTPUT_SAMPLE_RATE),
  );
  folder.file(
    "pax.wav",
    encodeFloatWav([pax], VOICE_DEMO_OUTPUT_SAMPLE_RATE),
  );
  folder.file(
    "mix.wav",
    encodeFloatWav([alex, pax], VOICE_DEMO_OUTPUT_SAMPLE_RATE),
  );
  folder.file(
    "transcript.txt",
    formatTranscript(input.transcriptEntries),
  );

  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  const zipBuffer = new Uint8Array(bytes).buffer;
  return {
    filename: `${input.folderName}.zip`,
    zip: zipBuffer,
  };
}

export function encodeFloatWav(
  channels: Float32Array[],
  sampleRate: number,
): Uint8Array {
  if (channels.length === 0) {
    throw new Error("A WAV file requires at least one channel");
  }
  const frameCount = channels[0]?.length ?? 0;
  if (!channels.every((channel) => channel.length === frameCount)) {
    throw new Error("WAV channels must have equal frame counts");
  }

  const bytesPerSample = 4;
  const blockAlign = channels.length * bytesPerSample;
  const dataByteLength = frameCount * blockAlign;
  const output = new Uint8Array(44 + dataByteLength);
  const view = new DataView(output.buffer);

  writeAscii(output, 0, "RIFF");
  view.setUint32(4, 36 + dataByteLength, true);
  writeAscii(output, 8, "WAVE");
  writeAscii(output, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 32, true);
  writeAscii(output, 36, "data");
  view.setUint32(40, dataByteLength, true);

  let offset = 44;
  for (let frame = 0; frame < frameCount; frame++) {
    for (const channel of channels) {
      view.setFloat32(offset, channel[frame] ?? 0, true);
      offset += bytesPerSample;
    }
  }
  return output;
}

function renderMonoTrack(
  segments: VoiceDemoAudioSegment[],
  frameCount: number,
): Float32Array {
  const output = new Float32Array(frameCount);
  for (const segment of segments) {
    renderSegment(segment, output);
  }
  return output;
}

function renderSegment(
  segment: VoiceDemoAudioSegment,
  output: Float32Array,
): void {
  if (
    segment.channels.length === 0 ||
    segment.sampleRate <= 0 ||
    segment.endT <= segment.startT
  ) {
    return;
  }

  const sourceChannels =
    segment.format === "int16"
      ? segment.channels.map((buffer) => new Int16Array(buffer))
      : segment.channels.map((buffer) => new Float32Array(buffer));
  const sourceFrameCount = Math.min(
    ...sourceChannels.map((channel) => channel.length),
  );
  if (sourceFrameCount === 0) {
    return;
  }

  const outputStart = Math.max(
    0,
    Math.round(segment.startT * VOICE_DEMO_OUTPUT_SAMPLE_RATE),
  );
  const scheduledFrames = Math.ceil(
    (segment.endT - segment.startT) * VOICE_DEMO_OUTPUT_SAMPLE_RATE,
  );
  const sourceFrames = Math.ceil(
    (sourceFrameCount / segment.sampleRate) *
      VOICE_DEMO_OUTPUT_SAMPLE_RATE,
  );
  const framesToRender = Math.min(
    scheduledFrames,
    sourceFrames,
    output.length - outputStart,
  );
  const sourceStep = segment.sampleRate / VOICE_DEMO_OUTPUT_SAMPLE_RATE;

  for (let outputFrame = 0; outputFrame < framesToRender; outputFrame++) {
    const sourcePosition = outputFrame * sourceStep;
    const before = Math.min(
      sourceFrameCount - 1,
      Math.floor(sourcePosition),
    );
    const after = Math.min(sourceFrameCount - 1, before + 1);
    const fraction = sourcePosition - before;
    let mono = 0;
    for (const channel of sourceChannels) {
      const first = sampleAsFloat(channel, before, segment.format);
      const second = sampleAsFloat(channel, after, segment.format);
      mono += first + (second - first) * fraction;
    }
    output[outputStart + outputFrame] += mono / sourceChannels.length;
  }
}

function sampleAsFloat(
  channel: Int16Array | Float32Array,
  index: number,
  format: VoiceDemoAudioSegment["format"],
): number {
  const value = channel[index] ?? 0;
  return format === "int16" ? value / 0x8000 : value;
}

function formatTranscript(entries: VoiceDemoTranscriptEntry[]): string {
  const lines = entries
    .filter((entry) => entry.text.trim().length > 0)
    .toSorted((left, right) => left.t - right.t)
    .map(
      (entry) =>
        `[${formatRelativeTime(entry.t)}] ${entry.speaker}: ${entry.text.trim()}`,
    );
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function formatRelativeTime(seconds: number): string {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const minutes = Math.floor(milliseconds / 60_000);
  const secondsWithinMinute = Math.floor((milliseconds % 60_000) / 1000);
  const millisecondsWithinSecond = milliseconds % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(secondsWithinMinute).padStart(2, "0")}.${String(millisecondsWithinSecond).padStart(3, "0")}`;
}

function writeAscii(output: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index++) {
    output[offset + index] = text.charCodeAt(index);
  }
}
