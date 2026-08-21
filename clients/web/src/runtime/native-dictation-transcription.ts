import type { VellumBridge } from "@vellumai/ipc-contract";

type NativeTranscriptionBridge = Required<
  Pick<
    VellumBridge["helper"]["dictation"],
    "transcribe" | "onTranscribed"
  >
>;

type NativeTranscriptionResult =
  | { ok: true; text: string | null }
  | { ok: false; reason?: string };

export async function requestNativeTranscription(
  bridge: NativeTranscriptionBridge,
  audio: ArrayBuffer,
  timeoutMs: number,
): Promise<NativeTranscriptionResult> {
  let resolveText!: (text: string | null) => void;
  const textPromise = new Promise<string | null>((resolve) => {
    resolveText = resolve;
  });
  const unsubscribe = bridge.onTranscribed((event) => {
    resolveText(event.text || null);
  });
  const timeout = setTimeout(() => resolveText(null), timeoutMs);

  try {
    const result = await bridge.transcribe(audio);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return { ok: true, text: await textPromise };
  } finally {
    clearTimeout(timeout);
    unsubscribe();
  }
}
