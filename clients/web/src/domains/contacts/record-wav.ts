/**
 * Microphone capture that yields exactly what the speaker model wants.
 *
 * MediaRecorder produces whatever the browser prefers (webm/opus in
 * Chrome, mp4 in Safari), but the daemon's front end takes 16 kHz mono
 * WAV. Rather than teach the daemon every browser codec, decode here
 * and re-encode once: the browser already has the decoders.
 */

/** Sample rate the speaker model was trained at. */
export const TARGET_SAMPLE_RATE = 16000;

export interface Recorder {
  /** Resolves with 16 kHz mono WAV bytes. */
  stop: () => Promise<Blob>;
  cancel: () => void;
}

/**
 * Start recording from the default microphone.
 *
 * Throws if permission is denied, which the caller should surface as
 * a prompt to allow the mic rather than as a generic failure.
 */
export async function startRecording(): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });

  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };
  recorder.start();

  const stopTracks = () => {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  };

  return {
    stop: () =>
      new Promise<Blob>((resolve, reject) => {
        recorder.onstop = () => {
          stopTracks();
          void (async () => {
            try {
              const blob = new Blob(chunks, { type: recorder.mimeType });
              resolve(await toWav16kMono(blob));
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          })();
        };
        recorder.stop();
      }),
    cancel: () => {
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
      stopTracks();
    },
  };
}

/**
 * Decode any browser-supported audio and re-encode as 16 kHz mono WAV.
 *
 * The resample and the downmix both happen inside OfflineAudioContext,
 * which does them properly; hand-rolling either is where this kind of
 * code usually goes quietly wrong.
 */
export async function toWav16kMono(input: Blob): Promise<Blob> {
  const bytes = await input.arrayBuffer();

  const decodeContext = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeContext.decodeAudioData(bytes.slice(0));
  } finally {
    void decodeContext.close();
  }

  const frames = Math.ceil(decoded.duration * TARGET_SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();

  return encodeWav(rendered.getChannelData(0), TARGET_SAMPLE_RATE);
}

/** Write mono float samples as a 16-bit PCM WAV. */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (const sample of samples) {
    // Clamp before scaling so a value slightly outside [-1, 1] wraps
    // to the opposite rail instead of clipping cleanly.
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(
      offset,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true,
    );
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}
